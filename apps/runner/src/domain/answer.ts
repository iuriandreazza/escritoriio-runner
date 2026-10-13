/** Whether what a person typed to a question that asks for a yes is one. Anything else, including nothing, is a no. */
export const isYes = (answer: string): boolean => /^y(es)?$/i.test(answer.trim());
