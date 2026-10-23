import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from './log';
import * as oniguruma from 'vscode-oniguruma';
import { IGrammar, INITIAL, IOnigLib, IRawTheme, parseRawGrammar, Registry, StateStack } from 'vscode-textmate';
import { classify, SymbolCategory } from './categories';

/** Máscara/offset da cor de frente nos metadados binários do vscode-textmate (EncodedTokenAttributes). */
const FOREGROUND_MASK = 0x00ff8000;
const FOREGROUND_OFFSET = 15;

/** Linhas maiores que isso não são tokenizadas (mesmo comportamento padrão do VS Code). */
const MAX_LINE_LENGTH = 20000;
const LINE_TIME_LIMIT_MS = 50;

export interface ColorSample {
  /** Cor de frente ("#rrggbb" ou "#rrggbbaa") → quantidade de caracteres visíveis com essa cor. */
  colors: Map<string, number>;
  /** Caracteres (não brancos) da categoria escolhida. */
  symbolChars: number;
  /** Total de caracteres (não brancos) visíveis. */
  totalChars: number;
}

interface DocumentCache {
  version: number;
  scopeName: string;
  /** states[i] = estado da gramática no início da linha i. */
  states: StateStack[];
}

let onigLib: Promise<IOnigLib> | undefined;

function loadOnigLib(): Promise<IOnigLib> {
  if (!onigLib) {
    const wasmPath = require.resolve('vscode-oniguruma/release/onig.wasm');
    const wasm = fs.readFileSync(wasmPath).buffer;
    onigLib = oniguruma.loadWASM(wasm).then(() => ({
      createOnigScanner: (patterns: string[]) => new oniguruma.OnigScanner(patterns),
      createOnigString: (s: string) => new oniguruma.OnigString(s),
    }));
  }
  return onigLib;
}

function countNonWhitespace(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) {
      count++;
    }
  }
  return count;
}

/** Tokeniza documentos com as gramáticas TextMate instaladas no VS Code. */
export class Tokenizer {
  private registry: Registry | undefined;
  private languageToScope = new Map<string, string>();
  private scopeToFile = new Map<string, string>();
  private injections = new Map<string, string[]>();
  private grammars = new Map<string, Promise<IGrammar | null>>();
  private caches = new Map<string, DocumentCache>();
  /** Incrementado a cada `reset`, para descartar amostragens iniciadas com o registro anterior. */
  private epoch = 0;

  constructor(private maxTokenizeLines: () => number) {}

  /** (Re)constrói o índice de gramáticas e cria um registro com o tema informado. */
  reset(theme: IRawTheme): void {
    this.epoch++;
    this.languageToScope.clear();
    this.scopeToFile.clear();
    this.injections.clear();
    this.grammars.clear();
    this.caches.clear();

    for (const ext of vscode.extensions.all) {
      const grammars: any[] = ext.packageJSON?.contributes?.grammars ?? [];
      for (const g of grammars) {
        if (!g.scopeName || !g.path) {
          continue;
        }
        const file = path.join(ext.extensionPath, g.path);
        // Extensões de outro host (ex.: local × devcontainer) aparecem na lista, mas seus arquivos não estão aqui.
        if (!fs.existsSync(file)) {
          continue;
        }
        this.scopeToFile.set(g.scopeName, file);
        if (g.language) {
          this.languageToScope.set(g.language, g.scopeName);
        }
        for (const target of g.injectTo ?? []) {
          const list = this.injections.get(target) ?? [];
          list.push(g.scopeName);
          this.injections.set(target, list);
        }
      }
    }

    this.registry?.dispose();
    this.registry = new Registry({
      onigLib: loadOnigLib(),
      theme,
      loadGrammar: async (scopeName) => {
        const file = this.scopeToFile.get(scopeName);
        if (!file) {
          return null;
        }
        const content = await fs.promises.readFile(file, 'utf8');
        return parseRawGrammar(content, file);
      },
      getInjections: (scopeName) => this.injections.get(scopeName),
    });
  }

  /** Invalida o estado salvo a partir da primeira linha alterada. */
  onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
    const cache = this.caches.get(event.document.uri.toString());
    if (!cache) {
      return;
    }
    let firstLine = Number.MAX_SAFE_INTEGER;
    for (const change of event.contentChanges) {
      firstLine = Math.min(firstLine, change.range.start.line);
    }
    if (cache.states.length > firstLine + 1) {
      cache.states.length = firstLine + 1;
    }
    cache.version = event.document.version;
  }

  onDocumentClosed(document: vscode.TextDocument): void {
    this.caches.delete(document.uri.toString());
  }

  private grammarFor(scopeName: string): Promise<IGrammar | null> {
    let grammar = this.grammars.get(scopeName);
    if (!grammar) {
      grammar = this.registry!.loadGrammar(scopeName).catch((err) => {
        log.error(`falha ao carregar a gramática "${scopeName}":`, err);
        return null;
      });
      this.grammars.set(scopeName, grammar);
    }
    return grammar;
  }

  /**
   * Analisa as linhas visíveis do editor e retorna as cores de frente dos tokens da
   * categoria pedida, ponderadas pela quantidade de caracteres.
   */
  async sample(editor: vscode.TextEditor, category: SymbolCategory): Promise<ColorSample | undefined> {
    const document = editor.document;
    const scopeName = this.languageToScope.get(document.languageId);
    if (!this.registry || !scopeName) {
      log.debug(`nenhuma gramática TextMate para a linguagem "${document.languageId}".`);
      return undefined;
    }
    const epoch = this.epoch;
    const grammar = await this.grammarFor(scopeName);
    if (!grammar || document.isClosed || epoch !== this.epoch) {
      return undefined;
    }

    const key = document.uri.toString();
    let cache = this.caches.get(key);
    if (!cache || cache.scopeName !== scopeName || cache.version !== document.version) {
      cache = { version: document.version, scopeName, states: [INITIAL] };
      this.caches.set(key, cache);
    }

    const colorMap = this.registry.getColorMap();
    const result: ColorSample = { colors: new Map(), symbolChars: 0, totalChars: 0 };
    const maxLines = this.maxTokenizeLines();

    for (const range of editor.visibleRanges) {
      const startLine = range.start.line;
      const endLine = Math.min(range.end.line, document.lineCount - 1);

      let state = this.stateAt(grammar, document, cache, startLine, maxLines);
      for (let line = startLine; line <= endLine; line++) {
        const text = document.lineAt(line).text;
        if (text.length > MAX_LINE_LENGTH) {
          this.storeState(cache, line + 1, state);
          continue;
        }
        const scoped = grammar.tokenizeLine(text, state, LINE_TIME_LIMIT_MS);
        const binary = grammar.tokenizeLine2(text, state, LINE_TIME_LIMIT_MS).tokens;
        state = scoped.ruleStack;
        this.storeState(cache, line + 1, state);

        result.totalChars += countNonWhitespace(text);

        let b = 0;
        for (const token of scoped.tokens) {
          if (classify(token.scopes) !== category) {
            continue;
          }
          const chars = countNonWhitespace(text.slice(token.startIndex, token.endIndex));
          if (chars === 0) {
            continue;
          }
          // Os tokens binários agrupam trechos com o mesmo estilo; acha o que cobre este token.
          while (b + 2 < binary.length && binary[b + 2] <= token.startIndex) {
            b += 2;
          }
          const colorId = (binary[b + 1] & FOREGROUND_MASK) >>> FOREGROUND_OFFSET;
          const color = colorMap[colorId];
          if (color) {
            result.colors.set(color, (result.colors.get(color) ?? 0) + chars);
            result.symbolChars += chars;
          }
        }
      }
    }
    return result;
  }

  private storeState(cache: DocumentCache, line: number, state: StateStack): void {
    if (cache.states.length === line) {
      cache.states.push(state);
    }
  }

  /** Estado no início de `line`, tokenizando (e memorizando) as linhas anteriores se preciso. */
  private stateAt(
    grammar: IGrammar,
    document: vscode.TextDocument,
    cache: DocumentCache,
    line: number,
    maxLines: number
  ): StateStack {
    if (line < cache.states.length) {
      return cache.states[line];
    }
    if (line > maxLines) {
      // Documento muito grande: começa do zero na área visível (menos preciso, mas rápido).
      return INITIAL;
    }
    let state = cache.states[cache.states.length - 1];
    for (let l = cache.states.length - 1; l < line; l++) {
      const text = document.lineAt(l).text;
      if (text.length <= MAX_LINE_LENGTH) {
        state = grammar.tokenizeLine2(text, state, LINE_TIME_LIMIT_MS).ruleStack;
      }
      cache.states.push(state);
    }
    return state;
  }

  dispose(): void {
    this.registry?.dispose();
    this.registry = undefined;
    this.caches.clear();
    this.grammars.clear();
  }
}
