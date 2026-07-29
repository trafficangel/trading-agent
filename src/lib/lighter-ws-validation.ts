export type LighterValidationMode = 'ticker' | 'nonce_chain' | 'invalid';

export function lighterValidationMode(input: {
  tickerFresh: boolean;
  tickerMatches: boolean;
  validatedChain: boolean;
}): LighterValidationMode {
  if (input.tickerFresh) {
    return input.tickerMatches ? 'ticker' : 'invalid';
  }
  return input.validatedChain ? 'nonce_chain' : 'invalid';
}
