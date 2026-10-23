import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from './log';
import * as jsonc from 'jsonc-parser';
import { IRawTheme, parseRawGrammar } from 'vscode-textmate';

type RawThemeSetting = IRawTheme['settings'][number];

export interface ThemeData {
  /** Id (ou label) do tema, como aparece em `workbench.colorTheme`. */
  name: string;
  /** Fundo do editor definido pelo tema (ou pelo usuário), antes da mescla. */
  background: string;
  /** Tema no formato aceito pelo vscode-textmate. */
  rawTheme: IRawTheme;
}

const DEFAULT_COLORS: Record<string, { background: string; foreground: string }> = {
  vs: { background: '#ffffff', foreground: '#000000' },
  'vs-dark': { background: '#1e1e1e', foreground: '#d4d4d4' },
  'hc-black': { background: '#000000', foreground: '#ffffff' },
  'hc-light': { background: '#ffffff', foreground: '#292929' },
};

/** Escopos usados pelos atalhos de `editor.tokenColorCustomizations` (iguais aos do VS Code). */
const CUSTOMIZATION_SHORTCUTS: Record<string, string[]> = {
  comments: ['comment', 'punctuation.definition.comment'],
  strings: ['string', 'meta.embedded.assembly'],
  keywords: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'],
  numbers: ['constant.numeric'],
  types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
  functions: ['entity.name.function', 'support.function'],
  variables: ['variable', 'entity.name.variable'],
};

/** Nome do tema efetivamente ativo, considerando a detecção automática de esquema de cores. */
export function activeThemeName(): string {
  const workbench = vscode.workspace.getConfiguration('workbench');
  const autoDetect = vscode.workspace.getConfiguration('window').get<boolean>('autoDetectColorScheme');
  if (autoDetect) {
    switch (vscode.window.activeColorTheme.kind) {
      case vscode.ColorThemeKind.Dark:
        return workbench.get<string>('preferredDarkColorTheme') ?? '';
      case vscode.ColorThemeKind.Light:
        return workbench.get<string>('preferredLightColorTheme') ?? '';
      case vscode.ColorThemeKind.HighContrast:
        return workbench.get<string>('preferredHighContrastColorTheme') ?? '';
      case vscode.ColorThemeKind.HighContrastLight:
        return workbench.get<string>('preferredHighContrastLightColorTheme') ?? '';
    }
  }
  return workbench.get<string>('colorTheme') ?? '';
}

function uiThemeFromKind(): string {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light:
      return 'vs';
    case vscode.ColorThemeKind.HighContrast:
      return 'hc-black';
    case vscode.ColorThemeKind.HighContrastLight:
      return 'hc-light';
    default:
      return 'vs-dark';
  }
}

function findThemeFile(name: string): { file: string; uiTheme: string } | undefined {
  const found = findThemeFileExact(name);
  // Nomes antigos dos temas embutidos ("Default Dark Modern" → "Dark Modern").
  return found ?? (name.startsWith('Default ') ? findThemeFileExact(name.slice('Default '.length)) : undefined);
}

function findThemeFileExact(name: string): { file: string; uiTheme: string } | undefined {
  for (const ext of vscode.extensions.all) {
    const themes: any[] = ext.packageJSON?.contributes?.themes ?? [];
    for (const theme of themes) {
      if ((theme.id ?? theme.label) === name || theme.label === name) {
        const file = path.join(ext.extensionPath, theme.path);
        // Extensões de outro host (ex.: local × devcontainer) aparecem na lista, mas seus arquivos não estão aqui.
        if (!fs.existsSync(file)) {
          log.warn(`tema "${name}" encontrado em ${file}, mas o arquivo não está acessível neste host.`);
          continue;
        }
        return { file, uiTheme: theme.uiTheme ?? 'vs-dark' };
      }
    }
  }
  return undefined;
}

async function readTokenColorsFile(file: string): Promise<RawThemeSetting[]> {
  const content = await fs.promises.readFile(file, 'utf8');
  if (/\.json$/i.test(file)) {
    const parsed = jsonc.parse(content);
    return Array.isArray(parsed) ? parsed : parsed?.settings ?? parsed?.tokenColors ?? [];
  }
  // .tmTheme (plist): o parser de gramáticas do vscode-textmate também lê plists genéricos.
  const parsed: any = parseRawGrammar(content, file);
  return parsed?.settings ?? [];
}

/** Lê um arquivo de tema JSON resolvendo `include` recursivamente. */
async function readThemeFile(
  file: string,
  depth = 0
): Promise<{ colors: Record<string, string>; tokenColors: RawThemeSetting[] }> {
  const content = await fs.promises.readFile(file, 'utf8');
  const theme = jsonc.parse(content) ?? {};
  let colors: Record<string, string> = {};
  let tokenColors: RawThemeSetting[] = [];

  if (typeof theme.include === 'string' && depth < 10) {
    const base = await readThemeFile(path.join(path.dirname(file), theme.include), depth + 1);
    colors = base.colors;
    tokenColors = base.tokenColors;
  }

  Object.assign(colors, theme.colors ?? {});

  if (typeof theme.tokenColors === 'string') {
    tokenColors = tokenColors.concat(await readTokenColorsFile(path.join(path.dirname(file), theme.tokenColors)));
  } else if (Array.isArray(theme.tokenColors)) {
    tokenColors = tokenColors.concat(theme.tokenColors);
  }

  return { colors, tokenColors };
}

function customizationRules(customization: any): RawThemeSetting[] {
  if (!customization || typeof customization !== 'object') {
    return [];
  }
  const rules: RawThemeSetting[] = [];
  for (const [key, scopes] of Object.entries(CUSTOMIZATION_SHORTCUTS)) {
    const value = customization[key];
    const settings = typeof value === 'string' ? { foreground: value } : value;
    if (settings && typeof settings === 'object') {
      rules.push({ scope: scopes, settings });
    }
  }
  if (Array.isArray(customization.textMateRules)) {
    rules.push(...customization.textMateRules);
  }
  return rules;
}

/** Regras do usuário (`editor.tokenColorCustomizations`), gerais e específicas do tema. */
function userTokenRules(themeName: string): RawThemeSetting[] {
  const value = vscode.workspace.getConfiguration('editor').get<any>('tokenColorCustomizations') ?? {};
  return [...customizationRules(value), ...customizationRules(value[`[${themeName}]`])];
}

/**
 * Carrega o tema ativo. `userBackground` é o fundo definido pelo próprio usuário em
 * `workbench.colorCustomizations` (se houver), que tem prioridade sobre o do tema.
 */
export async function loadActiveTheme(userBackground: string | undefined): Promise<ThemeData> {
  const name = activeThemeName();
  const located = findThemeFile(name);
  if (!located) {
    log.warn(`arquivo do tema "${name}" não encontrado; usando cores padrão (os símbolos não terão as cores do tema).`);
  }
  const uiTheme = located?.uiTheme ?? uiThemeFromKind();
  const defaults = DEFAULT_COLORS[uiTheme] ?? DEFAULT_COLORS['vs-dark'];

  let colors: Record<string, string> = {};
  let tokenColors: RawThemeSetting[] = [];
  if (located) {
    try {
      ({ colors, tokenColors } = await readThemeFile(located.file));
    } catch (err) {
      log.error(`falha ao ler o tema "${name}":`, err);
    }
  }

  const foreground = colors['editor.foreground'] ?? defaults.foreground;
  const background = userBackground ?? colors['editor.background'] ?? defaults.background;

  return {
    name,
    background,
    rawTheme: {
      name,
      settings: [{ settings: { foreground, background } }, ...tokenColors, ...userTokenRules(name)],
    },
  };
}
