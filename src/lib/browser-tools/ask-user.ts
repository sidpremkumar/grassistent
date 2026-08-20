import { BrowserTool, BrowserToolContext, asString } from './types';

/**
 * Lets the agent hand control back to the human mid-turn: ask a question,
 * offer options, or wait for the user to finish a manual step ("click Save,
 * then press Done"). The answer becomes the tool result, so the loop resumes
 * with the user's decision in context. The pause/continue architecture makes
 * this free — no connection is held open while the user thinks.
 */
export const askUserTool: BrowserTool = {
  spec: {
    name: 'ask_user',
    description:
      'Ask the user a question or wait for them to complete a manual step. Provide short "options" for ' +
      'quick answers (e.g. ["Done", "Cancel"] or concrete choices). Resolves with the option the user picked.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The question or instruction for the user' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Short answer options rendered as buttons (2-4 recommended)',
        },
      },
      required: ['prompt'],
    },
  },
  async execute(args: { input: Record<string, unknown>; ctx: BrowserToolContext }) {
    const prompt = asString(args.input.prompt);
    if (!prompt) {
      return { content: '"prompt" is required', isError: true };
    }
    const options = Array.isArray(args.input.options)
      ? args.input.options.filter((o): o is string => typeof o === 'string' && o.length > 0)
      : undefined;
    const answer = await args.ctx.promptUser({ prompt, options });
    return { content: `User answered: ${answer}` };
  },
};
