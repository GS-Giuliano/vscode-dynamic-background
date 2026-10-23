import * as vscode from 'vscode';

/** Canal "Dynamic Background" no painel Saída (nível de detalhe ajustável com "Developer: Set Log Level"). */
export const log = vscode.window.createOutputChannel('Dynamic Background', { log: true });
