import * as vscode from 'vscode';
import { log } from './log';
import { BackgroundWriter } from './background';
import { SymbolCategory } from './categories';
import { composite, mix, parseColor, RGBA, toHex } from './color';
import { activeThemeName, loadActiveTheme, ThemeData } from './theme';
import { CategorySample, ColorSample, Tokenizer } from './tokenizer';

const SECTION = 'dynamicBackground';

/** `auto` usa a categoria com mais caracteres na área visível. */
type SymbolSetting = SymbolCategory | 'auto';

const SYMBOL_LABELS: Record<SymbolSetting, string> = {
  auto: 'Mais frequente na tela',
  string: 'Strings',
  keyword: 'Comandos / palavras-chave',
  variable: 'Variáveis',
  type: 'Tipos',
  function: 'Funções',
  number: 'Números',
  comment: 'Comentários',
};

let writer: BackgroundWriter | undefined;

function config() {
  return vscode.workspace.getConfiguration(SECTION);
}

/** Média das cores de frente, ponderada pela quantidade de caracteres de cada uma. */
function averageColor(sample: CategorySample, background: RGBA): RGBA | undefined {
  let r = 0;
  let g = 0;
  let b = 0;
  let total = 0;
  for (const [hex, weight] of sample.colors) {
    const parsed = parseColor(hex);
    if (!parsed) {
      continue;
    }
    const color = composite(parsed, background);
    r += color.r * weight;
    g += color.g * weight;
    b += color.b * weight;
    total += weight;
  }
  return total ? { r: r / total, g: g / total, b: b / total, a: 1 } : undefined;
}

/** Categoria com mais caracteres visíveis. */
function mostFrequent(sample: ColorSample): SymbolCategory | undefined {
  let best: SymbolCategory | undefined;
  let bestChars = 0;
  for (const [category, entry] of sample.categories) {
    if (entry.chars > bestChars) {
      best = category;
      bestChars = entry.chars;
    }
  }
  return best;
}

class DynamicBackground implements vscode.Disposable {
  private theme: ThemeData | undefined;
  private tokenizer = new Tokenizer(() => config().get<number>('maxTokenizeLines', 5000));
  private timer: NodeJS.Timeout | undefined;
  private generation = 0;
  private initializing: Promise<void> | undefined;
  private reloadEpoch = 0;

  constructor(private writer: BackgroundWriter) {}

  /** Carrega tema e gramáticas e recalcula a cor. */
  reload(): Promise<void> {
    const epoch = ++this.reloadEpoch;
    this.initializing = (async () => {
      const theme = await loadActiveTheme();
      if (epoch !== this.reloadEpoch) {
        return; // Uma recarga mais recente já está em andamento.
      }
      this.tokenizer.reset(theme.rawTheme);
      this.theme = theme;
      log.info(`Tema "${theme.name}" carregado (fundo ${theme.background}).`);
    })().catch((err) => log.error('falha ao carregar o tema:', err));
    return this.initializing.then(() => this.schedule(0));
  }

  /** Recarrega só se o tema ativo realmente mudou (escrever as customizações também dispara eventos de tema). */
  onThemeEvent(): void {
    if (this.theme && activeThemeName() !== this.theme.name) {
      void this.reload();
    }
  }

  schedule(delay = config().get<number>('debounceMs', 100)): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.update();
    }, delay);
  }

  onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
    this.tokenizer.onDocumentChanged(event);
    if (event.document === vscode.window.activeTextEditor?.document) {
      this.schedule();
    }
  }

  onDocumentClosed(document: vscode.TextDocument): void {
    this.tokenizer.onDocumentClosed(document);
  }

  private async update(): Promise<void> {
    const generation = ++this.generation;
    let initializing: Promise<void> | undefined;
    do {
      initializing = this.initializing;
      await initializing;
    } while (initializing !== this.initializing);
    const theme = this.theme;
    if (!theme) {
      return;
    }
    if (!config().get<boolean>('enabled', true)) {
      await this.writer.restore();
      return;
    }
    // Com várias janelas abertas, só a janela em foco controla a cor (as configurações são globais).
    const editor = vscode.window.activeTextEditor;
    if (!editor || !vscode.window.state.focused) {
      return;
    }

    const background = parseColor(theme.background) ?? { r: 0, g: 0, b: 0, a: 1 };
    const setting = config().get<SymbolSetting>('symbol', 'auto');
    let sample: ColorSample | undefined;
    try {
      sample = await this.tokenizer.sample(editor);
    } catch (err) {
      log.error('falha ao tokenizar:', err);
    }
    if (generation !== this.generation) {
      return; // Já existe um cálculo mais recente.
    }

    const category = setting === 'auto' ? sample && mostFrequent(sample) : setting;
    const picked = category && sample?.categories.get(category);

    let result = background;
    const average = picked && averageColor(picked, background);
    if (sample && picked && average) {
      const intensity = Math.min(1, Math.max(0, config().get<number>('intensity', 0.2)));
      const density = sample.totalChars ? picked.chars / sample.totalChars : 0;
      const saturation = Math.max(0.01, config().get<number>('densitySaturation', 0.25));
      const factor = config().get<boolean>('scaleByDensity', true) ? Math.min(1, density / saturation) : 1;
      result = mix(background, average, intensity * factor);
    }
    log.debug(
      `linha ${editor.visibleRanges[0]?.start.line} ${setting}→${category ?? '-'}: ${picked?.chars ?? 0}/${sample?.totalChars ?? 0} caracteres,`,
      `cores ${JSON.stringify([...(picked?.colors ?? [])])} → ${toHex(result)}`
    );
    await this.writer.set(theme.name, toHex(result));
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.tokenizer.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  writer = new BackgroundWriter(context.globalState);
  const controller = new DynamicBackground(writer);
  const backgroundWriter = writer;

  context.subscriptions.push(
    log,
    controller,
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      if (e.textEditor === vscode.window.activeTextEditor) {
        controller.schedule();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => controller.schedule()),
    vscode.window.onDidChangeWindowState((state) => state.focused && controller.schedule()),
    vscode.workspace.onDidChangeTextDocument((e) => controller.onDocumentChanged(e)),
    vscode.workspace.onDidCloseTextDocument((d) => controller.onDocumentClosed(d)),
    vscode.window.onDidChangeActiveColorTheme(() => controller.onThemeEvent()),
    vscode.extensions.onDidChange(() => void controller.reload()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('workbench.colorTheme') ||
        e.affectsConfiguration('workbench.preferredDarkColorTheme') ||
        e.affectsConfiguration('workbench.preferredLightColorTheme') ||
        e.affectsConfiguration('workbench.preferredHighContrastColorTheme') ||
        e.affectsConfiguration('workbench.preferredHighContrastLightColorTheme') ||
        e.affectsConfiguration('window.autoDetectColorScheme') ||
        e.affectsConfiguration('editor.tokenColorCustomizations')
      ) {
        void controller.reload();
      } else if (e.affectsConfiguration(SECTION)) {
        controller.schedule(0);
      }
    }),
    vscode.commands.registerCommand(`${SECTION}.toggle`, async () => {
      const enabled = config().get<boolean>('enabled', true);
      await config().update('enabled', !enabled, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`Dynamic Background ${enabled ? 'desativado' : 'ativado'}`, 3000);
    }),
    vscode.commands.registerCommand(`${SECTION}.selectSymbol`, async () => {
      const current = config().get<SymbolSetting>('symbol', 'auto');
      const picked = await vscode.window.showQuickPick(
        (Object.keys(SYMBOL_LABELS) as SymbolSetting[]).map((value) => ({
          label: SYMBOL_LABELS[value],
          description: value === current ? `${value} (atual)` : value,
          value,
        })),
        { placeHolder: 'Cor de qual tipo de símbolo deve ser mesclada ao fundo?' }
      );
      if (picked) {
        await config().update('symbol', picked.value, vscode.ConfigurationTarget.Global);
      }
    }),
    vscode.commands.registerCommand(`${SECTION}.reload`, () => controller.reload())
  );

  // Restaura qualquer cor deixada por uma sessão anterior antes de começar.
  void backgroundWriter.restore().then(() => controller.reload());
}

export function deactivate(): Promise<void> | undefined {
  return writer?.restore();
}
