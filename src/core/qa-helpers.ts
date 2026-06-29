/**
 * Returns true when a message looks like a question or doubt rather than
 * a direct answer to a field prompt (fecha / hora / personas / nombre).
 * Used to route mid-flow messages to answerQuestion() instead of re-asking.
 */
export function isQuestion(text: string): boolean {
  return (
    /[?¿]/.test(text) ||
    /^\s*(qu[eé]|c[oó]mo|d[oó]nde|cu[aá]ndo|cu[aá]ntos?|cu[aá]l|por\s+qu[eé]|hay\s+|tienen?|sirven?|aceptan?|permiten?|cobran?|cu[aá]nto\s+(cuesta|cobran?|vale|son)|est[aá]n?\s+abiertos?|abren?|cierran?|a\s+qu[eé])/i.test(
      text.trim(),
    )
  );
}
