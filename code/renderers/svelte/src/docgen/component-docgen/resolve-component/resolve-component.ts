import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  createMetaComponentResolver,
  createModuleResolver,
  defaultResolveConditionNames,
  extractDeclaredSubcomponents,
  getStoryImportPathFromEntry,
  jsTsSourceExtensions,
  resolveImportedNamespace,
} from 'storybook/internal/common';
import {
  type CsfFile,
  type ESTree as E,
  type ESTreeNode,
  SourceEditor,
  collectImportBindings,
  loadCsf,
  oneLineTextOf,
  parseExpression,
  propertyValue,
  resolveReferencedValue,
  staticKey,
  type ReferenceModule,
  unwrapExpression,
} from 'storybook/internal/csf-tools';
import type { IndexEntry } from 'storybook/internal/types';

import { parseSvelteSource } from '../../../svelte-csf/indexer/parser.ts';
import { getDefineMetaFirstArgumentObjectExpression } from '../../../svelte-csf/parser/extract/svelte/define-meta.ts';
import { extractSvelteASTNodes } from '../../../svelte-csf/parser/extract/svelte/nodes.ts';

export interface ResolvedSvelteComponent {
  componentPath: string;
  exportName: string;
  name: string;
}

const moduleResolver = createModuleResolver({
  extensions: ['.svelte', ...jsTsSourceExtensions],
  // TypeScript projects import `./index.ts` as `./index.js`, as SvelteKit's packaging requires.
  extensionAlias: { '.js': ['.ts', '.js'] },
  mainFields: ['svelte', 'module', 'main'],
  // Core's conditions plus `svelte`, so a `storybook` entry resolves as it does in the preview.
  conditionNames: ['svelte', ...defaultResolveConditionNames],
  tsconfig: 'auto',
});

// Core and this module use one resolver, so a barrel that core follows lands on the same file that
// `followExport` reads.
const resolveMetaComponent = createMetaComponentResolver({ resolver: moduleResolver });

function resolveImport(fromFile: string, specifier: string): string | undefined {
  try {
    return moduleResolver.resolveFileSync(fromFile, specifier);
  } catch {
    return undefined;
  }
}

// Takes the import specifiers of both oxc and the Svelte parser, which type them differently.
function importedName(specifier: {
  type: string;
  imported?: { type: string; name?: string; value?: unknown };
}): string {
  if (specifier.type === 'ImportDefaultSpecifier') return 'default';
  if (specifier.type === 'ImportNamespaceSpecifier') return '*';
  return specifier.imported?.type === 'Identifier'
    ? String(specifier.imported.name)
    : String(specifier.imported?.value);
}

function exportedName(node: E.ModuleExportName): string {
  return node.type === 'Identifier' ? node.name : String(node.value);
}

function followExport(
  filePath: string,
  exportName: string,
  seen = new Set<string>()
): string | undefined {
  // A component is the default export of a `.svelte` file; its module script exports the rest.
  if (filePath.endsWith('.svelte') && exportName === 'default') return filePath;
  const key = `${filePath}#${exportName}`;
  if (seen.has(key)) return undefined;
  seen.add(key);

  const program = moduleProgram(filePath);
  if (!program) return undefined;
  const follow = (specifier: string, name: string) => {
    const target = resolveImport(filePath, specifier);
    return target ? followExport(target, name, seen) : undefined;
  };

  const followLocal = (localName: string) => {
    for (const declaration of program.body) {
      if (declaration.type !== 'ImportDeclaration' || declaration.importKind === 'type') continue;
      const imported = declaration.specifiers.find(
        (candidate) => candidate.local.name === localName
      );
      if (imported) return follow(declaration.source.value, importedName(imported));
    }
    return undefined;
  };

  for (const statement of program.body) {
    if (
      statement.type === 'ExportDefaultDeclaration' &&
      exportName === 'default' &&
      statement.declaration.type === 'Identifier'
    ) {
      return followLocal(statement.declaration.name);
    }
    if (statement.type === 'ExportAllDeclaration' && !statement.exported) {
      const found =
        exportName !== 'default' &&
        statement.exportKind !== 'type' &&
        follow(statement.source.value, exportName);
      if (found) return found;
    }
    if (statement.type !== 'ExportNamedDeclaration' || statement.exportKind === 'type') continue;
    const specifier = statement.specifiers.find(
      (candidate) => exportedName(candidate.exported) === exportName
    );
    if (!specifier || specifier.exportKind === 'type') continue;
    const localName = exportedName(specifier.local);
    return statement.source ? follow(statement.source.value, localName) : followLocal(localName);
  }
  return undefined;
}

// The editor of the JS a module exposes: a `.svelte` file's module script, or the file itself.
// `undefined` when it cannot be read or parsed.
function moduleEditor(filePath: string) {
  try {
    const file = readFileSync(filePath, 'utf8');
    if (!filePath.endsWith('.svelte')) return new SourceEditor(file, filePath);
    const { source, ast } = parseSvelteSource(file);
    const module = ast.module?.content as { start: number; end: number } | undefined;
    return module && new SourceEditor(source.slice(module.start, module.end), `${filePath}.ts`);
  } catch {
    return undefined;
  }
}

function moduleProgram(filePath: string) {
  return moduleEditor(filePath)?.program;
}

function locate(storyPath: string, specifier: string, exportName: string, name: string) {
  return locateIn(resolveImport(storyPath, specifier), specifier, exportName, name);
}

function locateIn(
  filePath: string | undefined,
  specifier: string,
  exportName: string,
  name: string
) {
  const componentPath = filePath && followExport(filePath, exportName);
  if (!componentPath) {
    throw new Error(`Could not resolve \`${specifier}\` export \`${exportName}\``);
  }
  return { componentPath, exportName, name };
}

// A story file read for the components it names: a CSF file, or a Svelte CSF file's `defineMeta`
// object and module script.
type StoryFile = { storyPath: string } & (
  | { csf: CsfFile }
  | { meta: E.ObjectExpression | undefined; module: ReferenceModule }
);

async function readStoryFile(entry: IndexEntry): Promise<StoryFile | undefined> {
  const importPath = getStoryImportPathFromEntry(entry);
  if (!importPath) return undefined;
  const storyPath = resolve(importPath);
  const file = await readFile(storyPath, 'utf8');
  return storyPath.endsWith('.svelte')
    ? { storyPath, ...(await readSvelteMeta(file, storyPath)) }
    : { storyPath, csf: loadCsf(file, { makeTitle: () => entry.title }).parse() };
}

// The component a node in the meta names: `meta.component` when `node` is left out, else one entry
// of `meta.subcomponents`. Throws when the node names an import that does not lead to a component.
function resolveComponentNode(
  story: StoryFile,
  node?: ESTreeNode
): ResolvedSvelteComponent | undefined {
  if ('csf' in story) {
    const resolved = resolveMetaComponent(story.csf, story.storyPath, node);
    if ('reason' in resolved) {
      if (resolved.reason === 'unreadable-component-expression') {
        throw new Error(`Cannot resolve the component \`${resolved.expression}\``);
      }
      return undefined;
    }
    // `path` is resolved in the module that wrote `importId`, which is not the story file when core
    // followed the component through another module, such as a barrel's `export * as`.
    const { importId, path, exportName, localName } = resolved.component;
    return importId ? locateIn(path, importId, exportName, localName) : undefined;
  }

  const expression = node ?? propertyValue(story.meta, 'component');
  return expression && resolveSvelteCsfComponent(expression, story.module, story.storyPath);
}

// Svelte CSF reads the module script with Svelte's own module reader, so a `.svelte` file in the
// chain exposes its module script, which core's reader cannot parse.
function resolveSvelteCsfComponent(
  node: ESTreeNode,
  module: ReferenceModule,
  storyPath: string
): ResolvedSvelteComponent | undefined {
  // Type arguments, as in `Button<{ id: number }>`, are type-level only.
  let expression = unwrapExpression(node);
  while (expression.type === 'TSInstantiationExpression') {
    expression = unwrapExpression(expression.expression);
  }
  const name =
    expression.type === 'Identifier'
      ? { local: expression.name }
      : expression.type === 'MemberExpression' &&
          !expression.computed &&
          expression.object.type === 'Identifier' &&
          expression.property.type === 'Identifier'
        ? { local: expression.object.name, property: expression.property.name }
        : undefined;
  if (!name) {
    throw new Error(`Cannot resolve the component \`${oneLineTextOf(node)}\``);
  }

  const binding = collectImportBindings(module.editor.program).get(name.local);
  if (!binding) return undefined;

  // A plain identifier keeps the import's imported name, which may be aliased or `default`.
  if (name.property === undefined) {
    return locate(storyPath, binding.importId, binding.importName, name.local);
  }
  const { property } = name;

  // `ns.Button` on a namespace import is `import { Button } from …` written another way, so the
  // property is the export name — the same shortcut core's resolver applies to namespaces.
  if (binding.importName === '*') {
    return locate(storyPath, binding.importId, property, property);
  }

  // A named import of a namespace a barrel exports, as in `export * as UI from './ui'`, is the
  // same shortcut one module further.
  const namespace = resolveImportedNamespace(
    moduleResolver,
    storyPath,
    binding.importId,
    binding.importName
  );
  if (namespace) {
    return locateIn(namespace.path, namespace.importId, property, property);
  }

  // A named object import (`import { Input }`) names the component through the object it binds,
  // not a module export — a module that also exports `Select` is not the component. Core's
  // reference resolver follows the object through spreads, aliases and export forms; where it
  // cannot, docgen declines rather than guessing.
  const parsed = new Map<string, ReferenceModule | undefined>();
  const referenced = resolveReferencedValue(
    {
      ...module,
      resolveModule: (fromFile, specifier) => {
        const target = resolveImport(fromFile, specifier);
        if (!target) return undefined;
        if (!parsed.has(target)) {
          const editor = moduleEditor(target);
          parsed.set(target, editor && { editor, filePath: target });
        }
        return parsed.get(target);
      },
    },
    expression
  );
  if (!referenced) return undefined;
  const value = unwrapExpression(referenced.node);
  if (value.type !== 'Identifier') return undefined;
  // The chain lands on a name in the module that wrote it: a component import, or a binding this
  // pass does not pretend to follow.
  const target = collectImportBindings(referenced.ctx.editor.program).get(value.name);
  if (!target) return undefined;
  return locate(referenced.ctx.filePath, target.importId, target.importName, property);
}

export async function resolveStoryComponent(
  entry: IndexEntry
): Promise<ResolvedSvelteComponent | undefined> {
  const story = await readStoryFile(entry);
  return story && resolveComponentNode(story);
}

// The components a meta lists in `subcomponents`, by the name it lists them under. They resolve
// like the meta's own component. One that does not resolve is left out, so it does not cost the
// main component its docs.
export async function resolveStorySubcomponents(
  entry: IndexEntry
): Promise<Record<string, ResolvedSvelteComponent>> {
  const story = await readStoryFile(entry);
  if (!story) return {};
  const declared =
    'csf' in story ? extractDeclaredSubcomponents(story.csf) : svelteSubcomponents(story);
  const resolved: Record<string, ResolvedSvelteComponent> = {};
  for (const { name, node } of declared) {
    try {
      const component = resolveComponentNode(story, node);
      if (component) resolved[name] = { ...component, name };
    } catch {
      continue;
    }
  }
  return resolved;
}

function svelteSubcomponents({ meta }: { meta: E.ObjectExpression | undefined }) {
  const subcomponents = propertyValue(meta, 'subcomponents');
  if (subcomponents?.type !== 'ObjectExpression') return [];
  return subcomponents.properties.flatMap((property) => {
    const name = property.type === 'Property' ? staticKey(property) : undefined;
    return name && property.type === 'Property' ? [{ name, node: property.value }] : [];
  });
}

async function readSvelteMeta(file: string, storyPath: string) {
  const { source, ast } = parseSvelteSource(file);
  const nodes = await extractSvelteASTNodes({ ast, filename: storyPath });
  const { start, end } = getDefineMetaFirstArgumentObjectExpression({
    nodes,
    filename: storyPath,
  }) as unknown as { start: number; end: number };
  const script = ast.module!.content as unknown as { start: number; end: number };
  const meta = parseExpression(source.slice(start, end));
  return {
    meta: meta.type === 'ObjectExpression' ? meta : undefined,
    module: {
      editor: new SourceEditor(source.slice(script.start, script.end), `${storyPath}.ts`),
      filePath: storyPath,
    },
  };
}
