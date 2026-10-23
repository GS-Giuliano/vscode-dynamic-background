import * as vscode from 'vscode';
import { log } from './log';

const STATE_KEY = 'dynamicBackground.applied';
const COLOR_KEY = 'editor.background';

/** O que havia na chave do tema antes de a extensão escrever, para poder restaurar depois. */
interface AppliedRecord {
  themeKey: string;
  previous?: string;
}

type Customizations = Record<string, any>;

function readGlobalCustomizations(): Customizations {
  const inspected = vscode.workspace.getConfiguration('workbench').inspect<Customizations>('colorCustomizations');
  return { ...(inspected?.globalValue ?? {}) };
}

async function writeGlobalCustomizations(value: Customizations): Promise<void> {
  await vscode.workspace
    .getConfiguration('workbench')
    .update(
      'colorCustomizations',
      Object.keys(value).length ? value : undefined,
      vscode.ConfigurationTarget.Global
    );
}

/**
 * Escreve `editor.background` em `workbench.colorCustomizations["[Tema]"]` nas
 * configurações do usuário, guardando o valor original para restauração.
 * As escritas são serializadas e apenas a cor mais recente pendente é gravada.
 */
export class BackgroundWriter {
  private desired: { themeKey: string; color: string | undefined } | undefined;
  private running: Promise<void> | undefined;
  private lastWritten: { themeKey: string; color: string } | undefined;

  constructor(private state: vscode.Memento) {}

  /**
   * Fundo definido pelo próprio usuário para o tema (ignorando o que a extensão escreveu),
   * ou o `editor.background` geral das customizações.
   */
  userBackground(themeName: string): string | undefined {
    const themeKey = `[${themeName}]`;
    const record = this.state.get<AppliedRecord>(STATE_KEY);
    const merged = vscode.workspace.getConfiguration('workbench').get<Customizations>('colorCustomizations') ?? {};
    const perTheme = record?.themeKey === themeKey ? record.previous : merged[themeKey]?.[COLOR_KEY];
    return perTheme ?? merged[COLOR_KEY];
  }

  /** Agenda a escrita da cor; `undefined` restaura o valor original. */
  set(themeName: string, color: string | undefined): Promise<void> {
    this.desired = { themeKey: `[${themeName}]`, color };
    if (!this.running) {
      this.running = this.drain().finally(() => (this.running = undefined));
    }
    return this.running;
  }

  /** Restaura o fundo original (inclusive de uma sessão anterior que não terminou limpa). */
  restore(): Promise<void> {
    this.desired = { themeKey: '', color: undefined };
    if (!this.running) {
      this.running = this.drain().finally(() => (this.running = undefined));
    }
    return this.running;
  }

  private async drain(): Promise<void> {
    while (this.desired) {
      const { themeKey, color } = this.desired;
      this.desired = undefined;
      try {
        await this.apply(themeKey, color);
      } catch (err) {
        log.error('falha ao gravar a cor de fundo:', err);
      }
    }
  }

  private async apply(themeKey: string, color: string | undefined): Promise<void> {
    const record = this.state.get<AppliedRecord>(STATE_KEY);

    if (color === undefined) {
      if (!record) {
        return;
      }
      const all = readGlobalCustomizations();
      const section = { ...(all[record.themeKey] ?? {}) };
      if (record.previous !== undefined) {
        section[COLOR_KEY] = record.previous;
      } else {
        delete section[COLOR_KEY];
      }
      if (Object.keys(section).length) {
        all[record.themeKey] = section;
      } else {
        delete all[record.themeKey];
      }
      await writeGlobalCustomizations(all);
      await this.state.update(STATE_KEY, undefined);
      this.lastWritten = undefined;
      return;
    }

    if (record && record.themeKey !== themeKey) {
      // O tema mudou: restaura o anterior antes de escrever no novo.
      await this.apply(record.themeKey, undefined);
    }
    if (this.lastWritten?.themeKey === themeKey && this.lastWritten.color === color) {
      return;
    }

    const all = readGlobalCustomizations();
    const section = { ...(all[themeKey] ?? {}) };
    if (!this.state.get<AppliedRecord>(STATE_KEY)) {
      await this.state.update(STATE_KEY, { themeKey, previous: section[COLOR_KEY] } satisfies AppliedRecord);
    }
    if (section[COLOR_KEY] === color) {
      this.lastWritten = { themeKey, color };
      return;
    }
    section[COLOR_KEY] = color;
    all[themeKey] = section;
    await writeGlobalCustomizations(all);
    this.lastWritten = { themeKey, color };
  }
}
