import type { CsfFile } from 'storybook/internal/csf-tools';

import { type E, type Node, unwrapExpression } from '../../csf-tools/estree/ast.ts';
import { parseReferenceModule } from '../../csf-tools/story-shape/reference-context.ts';
import { isSelfContained } from '../../csf-tools/story-shape/resolve-arg-value.ts';
import {
  type ReferenceModule,
  resolveReferencedValue,
  oneLineTextOf,
} from '../../csf-tools/story-shape/resolve-members.ts';
import { jsTsSourceExtensions } from '../../shared/constants/extensions.ts';
import { type ModuleResolver, createModuleResolver } from './module-resolver.ts';

/** The component a story file documents, as far as static analysis can determine. */
export interface ResolvedMetaComponent {
  /** Local identifier the component is bound to, in the module that names it. */
  localName: string;
  /** Specifier the component is imported from, or `undefined` when it is declared in the file. */
  importId?: string;
  /** Declaring module, or the naming module itself; `undefined` when the import does not resolve. */
  path?: string;
  /** Export name in the declaring module, so an import alias resolves to the real export. */
  exportName: string;
}

export type MetaComponentResolution =
  | { component: ResolvedMetaComponent }
  | { reason: 'no-meta-component' | 'no-component-import' }
  | {
      reason: 'unreadable-component-expression';
      /** Source text of the expression, so a caller can name what it could not follow. */
      expression: string;
    };

export type MetaComponentResolverOptions =
  | {
      /** Extensions tried ahead of the JS/TS set, for single-file-component formats like `.vue`. */
      extensions?: string[];
      resolver?: never;
    }
  | {
      /**
       * Resolves import specifiers in place of the default resolver, for a renderer whose packages
       * need their own conditions or extension aliases.
       */
      resolver: ModuleResolver;
      extensions?: never;
    };

/** Peels the type-level wrappers off a component expression, as in `Comp<Props>` or `Comp as any`. */
const unwrapComponentExpression = (node: Node): Node => {
  const unwrapped = unwrapExpression(node);
  return unwrapped.type === 'TSInstantiationExpression'
    ? unwrapComponentExpression(unwrapped.expression)
    : unwrapped;
};

/**
 * Builds a resolver that locates the component behind `meta.component` in a parsed CSF file.
 *
 * Server-side docgen never loads the story module, so the exported name and declaring file have to
 * be recovered from source; the resolver caches, so create one per host rather than per call.
 *
 * Passing `componentNode` resolves a different declared expression — a CSF `subcomponents` entry —
 * through the same import, namespace, and reference following; the default stays the meta's own
 * component annotation.
 */
export function createMetaComponentResolver(options: MetaComponentResolverOptions = {}) {
  const resolver =
    options.resolver ??
    createModuleResolver({
      extensions: [...(options.extensions ?? []), ...jsTsSourceExtensions],
      // TypeScript's ESM resolution imports `./ui.ts` as `./ui.js`.
      extensionAlias: {
        '.js': ['.ts', '.tsx', '.js'],
        '.jsx': ['.tsx', '.jsx'],
        '.mjs': ['.mts', '.mjs'],
        '.cjs': ['.cts', '.cjs'],
      },
      mainFields: ['module', 'main'],
      tsconfig: 'auto',
    });

  const resolveFile = (fromFile: string, specifier: string) =>
    resolveFileOrUndefined(resolver, fromFile, specifier);
  const resolveModule = (fromFile: string, specifier: string) =>
    resolveReferenceModule(resolver, fromFile, specifier);

  const fromIdentifier = (module: ReferenceModule, localName: string): MetaComponentResolution => {
    const binding = findImport(module.editor.program, localName);
    // A namespace object is not a class, so naming one as the component documents nothing.
    if (binding.kind === 'unsupported' || binding.kind === 'namespace') {
      return { reason: 'no-component-import' };
    }

    // A component declared in the module that names it is a real location, so reporting it lets a
    // caller explain why its docgen engine has no entry for it.
    if (binding.kind === 'local') {
      return { component: { localName, exportName: localName, path: module.filePath } };
    }

    const { importId, exportName } = binding;
    return {
      component: { localName, importId, exportName, path: resolveFile(module.filePath, importId) },
    };
  };

  return function resolveMetaComponent(
    csf: CsfFile,
    storyPath: string,
    componentNode?: Node
  ): MetaComponentResolution {
    // The component is printed source text, so only the parsed node shows whether the value is a
    // name this pass can follow.
    const node = componentNode ?? csf._metaAnnotations.component;
    if (!node) {
      return { reason: 'no-meta-component' };
    }

    const storyModule: ReferenceModule = { editor: csf.editor, filePath: storyPath };
    const expression = unwrapComponentExpression(node);
    if (expression.type === 'Identifier') {
      return fromIdentifier(storyModule, expression.name);
    }

    // `ns.Button`, where `ns` is a namespace, is `import { Button } from …` written another way, so it
    // resolves the same. The namespace can also come from a barrel, as in `export * as ns from …`.
    if (
      expression.type === 'MemberExpression' &&
      !expression.computed &&
      expression.object.type === 'Identifier' &&
      expression.property.type === 'Identifier'
    ) {
      const namespace = namespaceBinding(resolver, storyModule, expression.object.name, new Set());
      if (namespace) {
        const exportName = expression.property.name;
        return { component: { localName: exportName, exportName, ...namespace } };
      }
    }

    // A deeper property access (a shape another module owns, or a shared config object) is
    // followed to the name it lands on, which is then read in the module that binds it.
    const referenced = resolveReferencedValue(
      {
        ...storyModule,
        resolveModule,
        externalize: (n: Node) => (isSelfContained(n) ? n : undefined),
      },
      expression
    );
    if (referenced) {
      const value = unwrapComponentExpression(referenced.node);
      if (value.type === 'Identifier') {
        return fromIdentifier(referenced.ctx, value.name);
      }
    }

    return { reason: 'unreadable-component-expression', expression: oneLineTextOf(node) };
  };
}

/** The module a namespace stands for: its specifier, and the file that specifier resolves to. */
export type NamespaceModule = Required<Pick<ResolvedMetaComponent, 'importId'>> &
  Pick<ResolvedMetaComponent, 'path'>;

/**
 * The module that a named import stands for when the export it reads is a namespace, as `UI` is
 * after `export * as UI from './ui'`. Follows the export through re-exports, as a barrel writes
 * them; `undefined` when the export is not a namespace or cannot be followed.
 */
export function resolveImportedNamespace(
  resolver: ModuleResolver,
  fromFile: string,
  importId: string,
  exportName: string
): NamespaceModule | undefined {
  const module = resolveReferenceModule(resolver, fromFile, importId);
  return module && namespaceExport(resolver, module, exportName, new Set());
}

function namespaceExport(
  resolver: ModuleResolver,
  module: ReferenceModule,
  exportName: string,
  seen: Set<string>
): NamespaceModule | undefined {
  // Two barrels can re-export each other with `export *`, which would never end.
  const key = `${module.filePath}#${exportName}`;
  if (seen.has(key)) {
    return undefined;
  }
  seen.add(key);

  const forward = (specifier: string, name: string) => {
    const target = resolveReferenceModule(resolver, module.filePath, specifier);
    return target && namespaceExport(resolver, target, name, seen);
  };

  // An explicit export wins over `export *` wherever it is written, so the stars are tried last.
  const stars: string[] = [];
  for (const statement of module.editor.program.body) {
    if (statement.type === 'ExportAllDeclaration' && statement.exportKind !== 'type') {
      const specifier = statement.source.value;
      if (!statement.exported) {
        stars.push(specifier);
      } else if (moduleExportName(statement.exported) === exportName) {
        return {
          importId: specifier,
          path: resolveFileOrUndefined(resolver, module.filePath, specifier),
        };
      }
      continue;
    }

    if (statement.type !== 'ExportNamedDeclaration' || statement.exportKind === 'type') {
      continue;
    }
    // `export const UI = …` is a value, not a namespace, and it still shadows any `export *`.
    if (statement.declaration && declares(module, statement.declaration, exportName)) {
      return undefined;
    }
    const specifier = statement.specifiers.find(
      (candidate) =>
        candidate.exportKind !== 'type' && moduleExportName(candidate.exported) === exportName
    );
    if (!specifier) {
      continue;
    }
    const localName = moduleExportName(specifier.local);
    // `import * as UI from './ui'; export { UI }` is `export * as UI from './ui'` in two steps.
    return statement.source
      ? forward(statement.source.value, localName)
      : namespaceBinding(resolver, module, localName, seen);
  }

  // `export *` forwards every name but `default`.
  if (exportName === 'default') {
    return undefined;
  }
  for (const specifier of stars) {
    const found = forward(specifier, exportName);
    if (found) {
      return found;
    }
  }
  return undefined;
}

// The module a name stands for as a namespace, in the module that binds the name.
function namespaceBinding(
  resolver: ModuleResolver,
  module: ReferenceModule,
  localName: string,
  seen: Set<string>
): NamespaceModule | undefined {
  const binding = findImport(module.editor.program, localName);
  if (binding.kind === 'namespace') {
    return {
      importId: binding.importId,
      path: resolveFileOrUndefined(resolver, module.filePath, binding.importId),
    };
  }
  if (binding.kind !== 'import') {
    return undefined;
  }
  const target = resolveReferenceModule(resolver, module.filePath, binding.importId);
  return target && namespaceExport(resolver, target, binding.exportName, seen);
}

function resolveFileOrUndefined(
  resolver: ModuleResolver,
  fromFile: string,
  specifier: string
): string | undefined {
  try {
    return resolver.resolveFileSync(fromFile, specifier);
  } catch {
    return undefined;
  }
}

function resolveReferenceModule(
  resolver: ModuleResolver,
  fromFile: string,
  specifier: string
): ReferenceModule | undefined {
  const filePath = resolveFileOrUndefined(resolver, fromFile, specifier);
  return filePath ? parseReferenceModule(filePath) : undefined;
}

type ImportBinding =
  | { kind: 'import'; importId: string; exportName: string }
  | { kind: 'namespace'; importId: string }
  | { kind: 'local' }
  | { kind: 'unsupported' };

function findImport(program: E.Program, localName: string): ImportBinding {
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') {
      continue;
    }

    for (const specifier of statement.specifiers) {
      if (specifier.local.name !== localName) {
        continue;
      }

      // A type-only import binds nothing documentable, but the name is still imported rather than
      // declared here.
      if (statement.importKind === 'type') {
        return { kind: 'unsupported' };
      }

      const importId = statement.source.value;
      if (specifier.type === 'ImportNamespaceSpecifier') {
        return { kind: 'namespace', importId };
      }
      if (specifier.type === 'ImportDefaultSpecifier') {
        return { kind: 'import', importId, exportName: 'default' };
      }
      if (specifier.importKind === 'type') {
        return { kind: 'unsupported' };
      }
      return {
        kind: 'import',
        importId,
        exportName: moduleExportName(specifier.imported),
      };
    }
  }

  return { kind: 'local' };
}

function declares(module: ReferenceModule, declaration: Node, name: string): boolean {
  if (declaration.type === 'VariableDeclaration') {
    // A destructuring pattern can bind the name anywhere inside it, so the scope says where.
    const identifier = module.editor.scopes.program.bindings.get(name)?.identifier;
    return (
      !!identifier && identifier.start >= declaration.start && identifier.end <= declaration.end
    );
  }
  // Functions, classes, enums and TS namespaces name themselves in `id`.
  return (
    'id' in declaration && declaration.id?.type === 'Identifier' && declaration.id.name === name
  );
}

// A specifier can write the name as a string, as in `export { a as 'b' }`.
function moduleExportName(node: E.ModuleExportName): string {
  return node.type === 'Identifier' ? node.name : (node as E.StringLiteral).value;
}
