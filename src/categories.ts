export type SymbolCategory = 'string' | 'keyword' | 'variable' | 'type' | 'function' | 'number' | 'comment';

/**
 * Regras de classificação por escopo TextMate. A ordem importa: para um mesmo
 * escopo, a primeira categoria que casar vence (ex.: `variable.function` é função,
 * `storage.type.primitive` é tipo).
 */
const RULES: [SymbolCategory, RegExp][] = [
  ['comment', /^(comment|punctuation\.definition\.comment)\b/],
  ['string', /^(string|punctuation\.definition\.string|constant\.character\.escape)\b/],
  ['function', /^(entity\.name\.function|support\.function|variable\.function|meta\.function-call\.generic)\b/],
  [
    'type',
    /^(entity\.name\.(type|class|interface|enum|struct|trait)|entity\.other\.inherited-class|support\.(type|class)|storage\.type\.(primitive|built-in|builtin))\b/,
  ],
  ['number', /^constant\.numeric\b/],
  [
    'keyword',
    /^(keyword(?!\.operator)|keyword\.operator\.(new|expression|word|wordlike|logical\.python|instanceof|typeof|delete|sizeof|alignof)|storage\.(type|modifier)|variable\.language\.(this|self|super))\b/,
  ],
  ['variable', /^(variable|entity\.name\.variable|support\.variable|variable\.other\.constant)\b/],
];

/**
 * Classifica um token pela pilha de escopos (do mais externo ao mais interno),
 * percorrendo do mais interno para fora até encontrar um escopo significativo.
 */
export function classify(scopes: readonly string[]): SymbolCategory | undefined {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i];
    for (const [category, regex] of RULES) {
      if (regex.test(scope)) {
        return category;
      }
    }
  }
  return undefined;
}
