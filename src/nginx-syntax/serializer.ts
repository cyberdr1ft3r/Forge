import {argumentIdentity, serializeArgument} from './arguments.js';
import {getBlockDefinition, getDirectiveDefinition} from './registry.js';
import type {BlockNode, DirectiveNode, MapEntryNode, NginxDocument, NginxNode} from './types.js';
import {validateNginxDocument, validateNginxHttpFragment} from './validator.js';
import type {NginxCompilation} from './types.js';

function nodeSortKey(node: NginxNode): string {
  if (node.kind === 'directive') {
    const definition = getDirectiveDefinition(node.name);
    return `0:${String(definition?.order ?? 9999).padStart(4, '0')}:${node.name}:${node.args.map(argumentIdentity).join('|')}`;
  }
  if (node.kind === 'map-entry') return `1:${argumentIdentity(node.key)}`;
  const definition = getBlockDefinition(node.blockType);
  return `2:${String(definition?.order ?? 9999).padStart(4, '0')}:${node.blockType}:${node.header.map(argumentIdentity).join('|')}`;
}

function canonicalChildren(block: BlockNode | NginxDocument): readonly NginxNode[] {
  if ('blockType' in block && block.blockType === 'map') return [...block.children];
  return [...block.children].sort((left, right) => nodeSortKey(left).localeCompare(nodeSortKey(right), 'en'));
}

function serializeDirective(node: DirectiveNode, indentation: string): string {
  const definition = getDirectiveDefinition(node.name);
  const name = definition?.nginxName ?? node.name;
  const argumentsText = node.args.map(serializeArgument).join(' ');
  return `${indentation}${name}${argumentsText.length > 0 ? ` ${argumentsText}` : ''};`;
}

function serializeMapEntry(node: MapEntryNode, indentation: string): string {
  return `${indentation}${serializeArgument(node.key)} ${serializeArgument(node.value)};`;
}

function serializeBlock(node: BlockNode, depth: number): string {
  const indentation = '    '.repeat(depth);
  const header = node.header.map(serializeArgument).join(' ');
  const opening = `${indentation}${node.blockType}${header.length > 0 ? ` ${header}` : ''} {`;
  const children = canonicalChildren(node).map(child => serializeNode(child, depth + 1)).join('\n');
  return `${opening}${children.length > 0 ? `\n${children}\n` : '\n'}${indentation}}`;
}

function serializeNode(node: NginxNode, depth: number): string {
  if (node.kind === 'directive') return serializeDirective(node, '    '.repeat(depth));
  if (node.kind === 'map-entry') return serializeMapEntry(node, '    '.repeat(depth));
  return serializeBlock(node, depth);
}

function render(document: NginxDocument): string {
  return `${canonicalChildren(document).map(node => serializeNode(node, 0)).join('\n\n')}\n`;
}

export function serializeNginxDocument(document: unknown): NginxCompilation {
  const diagnostics = validateNginxDocument(document);
  if (diagnostics.some(item => item.severity === 'error')) return {ok: false, artifacts: [], diagnostics};
  const validDocument = document as NginxDocument;
  const fullConfig = validDocument.profile === 'full-config';
  return {
    ok: true,
    artifacts: [{
      id: fullConfig ? 'nginx-config' : 'nginx-site-fragment',
      filename: fullConfig ? 'nginx.conf' : 'site.conf',
      mediaType: 'text/nginx',
      role: 'primary',
      content: render(validDocument),
    }],
    diagnostics,
  };
}

export function serializeNginxHttpFragment(children: unknown): NginxCompilation {
  const diagnostics = validateNginxHttpFragment(children);
  if (diagnostics.some(item => item.severity === 'error')) return {ok: false, artifacts: [], diagnostics};
  const nodes = children as readonly NginxNode[];
  return {
    ok: true,
    artifacts: [{
      id: 'nginx-http-shared',
      filename: 'http-shared.conf',
      mediaType: 'text/nginx',
      role: 'primary',
      content: `${[...nodes].sort((left, right) => nodeSortKey(left).localeCompare(nodeSortKey(right), 'en')).map(node => serializeNode(node, 0)).join('\n\n')}\n`,
    }],
    diagnostics,
  };
}
