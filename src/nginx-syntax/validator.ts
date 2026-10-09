import type {Diagnostic} from '../core/types.js';
import {argumentIdentity, validateArgument} from './arguments.js';
import {getBlockDefinition, getDirectiveDefinition} from './registry.js';
import type {ArgumentRule} from './registry.js';
import type {BlockNode, DirectiveNode, NginxContext, NginxDocument, NginxNode, NginxSourceProvenance} from './types.js';

const error = (code: string, message: string, path: string): Diagnostic => ({code, message, path, severity: 'error', stage: 'static'});

function argumentValueIdentity(argument: unknown): string {
  if (argument === null || typeof argument !== 'object') return 'invalid';
  return String((argument as {value?: unknown}).value);
}

function validateSource(source: unknown, path: string): readonly Diagnostic[] {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return [error('nginx.source.type', 'Node source provenance must be an object.', path)];
  const candidate = source as Partial<NginxSourceProvenance>;
  const diagnostics: Diagnostic[] = [];
  if (candidate.kind !== 'engine' && candidate.kind !== 'generator' && candidate.kind !== 'capability') diagnostics.push(error('nginx.source.kind', 'Source kind must be engine, generator, or capability.', `${path}.kind`));
  if (typeof candidate.id !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(candidate.id)) diagnostics.push(error('nginx.source.id', 'Source ID must be a stable lowercase identifier.', `${path}.id`));
  if (candidate.version !== undefined && (typeof candidate.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(candidate.version))) diagnostics.push(error('nginx.source.version', 'Source version must use semantic versioning.', `${path}.version`));
  if (candidate.siteId !== undefined && (typeof candidate.siteId !== 'string' || !/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(candidate.siteId))) diagnostics.push(error('nginx.source.site-id', 'Source site ID must be a stable lowercase identifier.', `${path}.siteId`));
  return diagnostics;
}

function validateArguments(args: unknown, rules: readonly ArgumentRule[], path: string): readonly Diagnostic[] {
  if (!Array.isArray(args)) return [error('nginx.argument.list', 'Arguments must be an array of typed values.', path)];
  const diagnostics: Diagnostic[] = [];
  let argumentIndex = 0;
  for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
    const rule = rules[ruleIndex];
    if (rule === undefined) continue;
    if (rule.variadic === true) {
      if (argumentIndex >= args.length && rule.optional !== true) diagnostics.push(error('nginx.argument.missing', 'At least one argument is required.', `${path}[${argumentIndex}]`));
      while (argumentIndex < args.length) {
        const message = validateArgument(args[argumentIndex], rule);
        if (message !== undefined) diagnostics.push(error('nginx.argument.invalid', message, `${path}[${argumentIndex}]`));
        argumentIndex += 1;
      }
      continue;
    }
    if (argumentIndex >= args.length) {
      if (rule.optional !== true) diagnostics.push(error('nginx.argument.missing', 'Required argument is missing.', `${path}[${argumentIndex}]`));
      continue;
    }
    const message = validateArgument(args[argumentIndex], rule);
    if (message !== undefined) diagnostics.push(error('nginx.argument.invalid', message, `${path}[${argumentIndex}]`));
    argumentIndex += 1;
  }
  if (argumentIndex < args.length) diagnostics.push(error('nginx.argument.extra', 'Directive or block has too many arguments.', `${path}[${argumentIndex}]`));
  return diagnostics;
}

function blockIdentity(block: BlockNode): string {
  const header = Array.isArray(block.header) ? block.header : [];
  switch (block.blockType) {
    case 'map':
      return argumentIdentity(header[1]);
    case 'location':
    case 'upstream':
      return argumentIdentity(header[0]);
    default:
      return block.blockType;
  }
}

interface ServerDescriptor {
  readonly listeners: readonly {readonly identity: string; readonly mode: string; readonly defaultServer: boolean}[];
  readonly names: readonly string[];
}

function serverDescriptor(block: BlockNode): ServerDescriptor {
  if (!Array.isArray(block.children)) return {listeners: [], names: []};
  const directives = block.children.filter((node): node is DirectiveNode => node !== null && typeof node === 'object' && !Array.isArray(node) && node.kind === 'directive' && Array.isArray(node.args));
  const listeners = directives.filter(node => node.name === 'listen').map(node => {
    const option = argumentValueIdentity(node.args[1]);
    return {identity: argumentValueIdentity(node.args[0]), mode: option === 'ssl' ? 'ssl' : 'plain', defaultServer: option === 'default_server'};
  });
  const names = directives.filter(node => node.name === 'server_name').flatMap(node => node.args.map(argumentValueIdentity));
  return {listeners, names};
}

function validateSiblingConflicts(children: readonly unknown[], parent: NginxContext, path: string): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const directiveKeys = new Map<string, number>();
  const blockKeys = new Map<string, number>();
  const serverKeys = new Map<string, number>();
  const listenerModes = new Map<string, {readonly mode: string; readonly index: number}>();
  const defaultListeners = new Map<string, number>();

  children.forEach((node, index) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    const candidate = node as Partial<NginxNode> & {kind?: unknown};
    if (candidate.kind === 'directive') {
      const directiveNode = candidate as Partial<DirectiveNode>;
      const definition = getDirectiveDefinition(String(directiveNode.name));
      if (definition === undefined || definition.repeatability === 'repeatable') return;
      const args = Array.isArray(directiveNode.args) ? directiveNode.args : [];
      const key = definition.repeatability === 'single' ? definition.id : `${definition.id}:${argumentIdentity(args[0])}`;
      const first = directiveKeys.get(key);
      if (first !== undefined) diagnostics.push(error('nginx.directive.duplicate', `Duplicate or conflicting ${definition.nginxName} declaration; first declared at ${path}[${first}].`, `${path}[${index}]`));
      else directiveKeys.set(key, index);
      return;
    }
    if (candidate.kind === 'block') {
      const blockNode = candidate as Partial<BlockNode>;
      const definition = getBlockDefinition(String(blockNode.blockType));
      if (definition !== undefined && definition.repeatability !== 'repeatable') {
        const key = definition.repeatability === 'single' ? definition.blockType : `${definition.blockType}:${blockIdentity(blockNode as BlockNode)}`;
        const first = blockKeys.get(key);
        if (first !== undefined) diagnostics.push(error('nginx.block.duplicate', `Duplicate or conflicting ${definition.blockType} block; first declared at ${path}[${first}].`, `${path}[${index}]`));
        else blockKeys.set(key, index);
      }
      if (parent === 'http' && blockNode.blockType === 'server') {
        const descriptor = serverDescriptor(blockNode as BlockNode);
        for (const listener of descriptor.listeners) {
          const existingMode = listenerModes.get(listener.identity);
          if (existingMode !== undefined && existingMode.mode !== listener.mode) diagnostics.push(error('nginx.listener.mode-conflict', `Listener ${listener.identity} mixes ${existingMode.mode} and ${listener.mode} modes; first declared at ${path}[${existingMode.index}].`, `${path}[${index}]`));
          else if (existingMode === undefined) listenerModes.set(listener.identity, {mode: listener.mode, index});
          if (listener.defaultServer) {
            const firstDefault = defaultListeners.get(listener.identity);
            if (firstDefault !== undefined) diagnostics.push(error('nginx.listener.default-conflict', `Listener ${listener.identity} declares more than one default server; first declared at ${path}[${firstDefault}].`, `${path}[${index}]`));
            else defaultListeners.set(listener.identity, index);
          }
          for (const name of descriptor.names) {
            const identity = `${listener.identity}:${name}`;
            const first = serverKeys.get(identity);
            if (first !== undefined) diagnostics.push(error('nginx.server.conflict', `Server name ${name} is already assigned to listener ${listener.identity} at ${path}[${first}].`, `${path}[${index}]`));
            else serverKeys.set(identity, index);
          }
        }
      }
    }
  });
  return diagnostics;
}

function validateNode(node: unknown, parent: NginxContext, path: string): readonly Diagnostic[] {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return [error('nginx.node.type', 'Nginx node must be an object.', path)];
  const candidate = node as Partial<NginxNode> & {kind?: unknown};
  const diagnostics: Diagnostic[] = [];
  diagnostics.push(...validateSource((candidate as {source?: unknown}).source, `${path}.source`));

  if (candidate.kind === 'directive') {
    const definition = getDirectiveDefinition(String((candidate as {name?: unknown}).name));
    if (definition === undefined) return [...diagnostics, error('nginx.directive.unsupported', `Unsupported directive: ${String((candidate as {name?: unknown}).name)}.`, `${path}.name`)];
    if (!definition.contexts.includes(parent)) diagnostics.push(error('nginx.directive.context', `${definition.nginxName} is not allowed in ${parent} context.`, path));
    diagnostics.push(...validateArguments((candidate as {args?: unknown}).args, definition.arguments, `${path}.args`));
    if (definition.id === 'upstream_server' && Array.isArray((candidate as {args?: unknown}).args)) {
      const values = ((candidate as {args: readonly unknown[]}).args).slice(1).map(argumentValueIdentity);
      const parameterKeys = new Map<string, number>();
      values.forEach((value, index) => {
        const key = value.split('=', 1)[0] ?? value;
        const first = parameterKeys.get(key);
        if (first !== undefined) diagnostics.push(error('nginx.upstream.parameter-duplicate', `Duplicate upstream server parameter ${key}; first declared at ${path}.args[${first + 1}].`, `${path}.args[${index + 1}]`));
        else parameterKeys.set(key, index);
      });
      if (parameterKeys.has('backup') && parameterKeys.has('down')) diagnostics.push(error('nginx.upstream.backend-state', 'An upstream server cannot be both backup and down.', `${path}.args`));
    }
    return diagnostics;
  }

  if (candidate.kind === 'map-entry') {
    if (parent !== 'map') diagnostics.push(error('nginx.map-entry.context', 'Map entries are allowed only inside a map block.', path));
    const entryRule: ArgumentRule = {kinds: ['literal', 'domain', 'variable', 'keyword', 'quoted'], keywords: ['default']};
    diagnostics.push(...validateArguments([(candidate as {key?: unknown}).key], [entryRule], `${path}.key`));
    diagnostics.push(...validateArguments([(candidate as {value?: unknown}).value], [{kinds: ['literal', 'variable', 'keyword', 'quoted'], keywords: ['on', 'off']}], `${path}.value`));
    return diagnostics;
  }

  if (candidate.kind === 'block') {
    const definition = getBlockDefinition(String((candidate as {blockType?: unknown}).blockType));
    if (definition === undefined) return [...diagnostics, error('nginx.block.unsupported', `Unsupported block: ${String((candidate as {blockType?: unknown}).blockType)}.`, `${path}.blockType`)];
    if (!definition.parents.includes(parent)) diagnostics.push(error('nginx.block.context', `${definition.blockType} block is not allowed inside ${parent} context.`, path));
    diagnostics.push(...validateArguments((candidate as {header?: unknown}).header, definition.header, `${path}.header`));
    const children = (candidate as {children?: unknown}).children;
    if (!Array.isArray(children)) {
      diagnostics.push(error('nginx.block.children', 'Block children must be an array.', `${path}.children`));
      return diagnostics;
    }
    diagnostics.push(...validateSiblingConflicts(children as readonly NginxNode[], definition.blockType, `${path}.children`));
    children.forEach((child, index) => diagnostics.push(...validateNode(child, definition.blockType, `${path}.children[${index}]`)));
    if (definition.blockType === 'map') {
      const keys = new Map<string, number>();
      children.forEach((child, index) => {
        if (child !== null && typeof child === 'object' && !Array.isArray(child) && (child as {kind?: unknown}).kind === 'map-entry') {
          const key = argumentValueIdentity((child as {key?: unknown}).key);
          const first = keys.get(key);
          if (first !== undefined) diagnostics.push(error('nginx.map-entry.duplicate', `Duplicate map key; first declared at ${path}.children[${first}].`, `${path}.children[${index}]`));
          else keys.set(key, index);
        }
      });
    }
    return diagnostics;
  }

  return [...diagnostics, error('nginx.node.kind', `Unsupported node kind: ${String(candidate.kind)}.`, `${path}.kind`)];
}

export function validateNginxDocument(document: unknown): readonly Diagnostic[] {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return [error('nginx.document.type', 'Nginx document must be an object.', 'document')];
  const candidate = document as Partial<NginxDocument>;
  const diagnostics: Diagnostic[] = [...validateSource(candidate.source, 'document.source')];
  if (candidate.profile !== 'full-config' && candidate.profile !== 'site-fragment') diagnostics.push(error('nginx.profile.unsupported', `Unsupported output profile: ${String(candidate.profile)}.`, 'document.profile'));
  if (!Array.isArray(candidate.children)) {
    diagnostics.push(error('nginx.document.children', 'Document children must be an array.', 'document.children'));
    return diagnostics;
  }

  if (candidate.profile === 'full-config') {
    const eventBlocks = candidate.children.filter(node => node !== null && typeof node === 'object' && !Array.isArray(node) && node.kind === 'block' && node.blockType === 'events').length;
    const httpBlocks = candidate.children.filter(node => node !== null && typeof node === 'object' && !Array.isArray(node) && node.kind === 'block' && node.blockType === 'http').length;
    if (eventBlocks !== 1) diagnostics.push(error('nginx.profile.events', 'A full configuration requires exactly one events block.', 'document.children'));
    if (httpBlocks !== 1) diagnostics.push(error('nginx.profile.http', 'A full configuration requires exactly one http block.', 'document.children'));
    diagnostics.push(...validateSiblingConflicts(candidate.children, 'main', 'document.children'));
    candidate.children.forEach((node, index) => diagnostics.push(...validateNode(node, 'main', `document.children[${index}]`)));
  } else if (candidate.profile === 'site-fragment') {
    if (candidate.children.length === 0) diagnostics.push(error('nginx.profile.empty', 'A site fragment requires at least one server block.', 'document.children'));
    candidate.children.forEach((node, index) => {
      if (node === null || typeof node !== 'object' || Array.isArray(node) || node.kind !== 'block' || node.blockType !== 'server') diagnostics.push(error('nginx.profile.site-root', 'Site fragments may contain only server blocks at the document root.', `document.children[${index}]`));
    });
    diagnostics.push(...validateSiblingConflicts(candidate.children, 'http', 'document.children'));
    candidate.children.forEach((node, index) => diagnostics.push(...validateNode(node, 'http', `document.children[${index}]`)));
  }
  return diagnostics;
}

export function validateNginxHttpFragment(children: unknown): readonly Diagnostic[] {
  if (!Array.isArray(children)) return [error('nginx.fragment.children', 'HTTP fragment children must be an array.', 'fragment.children')];
  const diagnostics: Diagnostic[] = children.length === 0 ? [error('nginx.fragment.empty', 'HTTP fragment requires at least one node.', 'fragment.children')] : [];
  diagnostics.push(...validateSiblingConflicts(children, 'http', 'fragment.children'));
  children.forEach((node, index) => diagnostics.push(...validateNode(node, 'http', `fragment.children[${index}]`)));
  return diagnostics;
}
