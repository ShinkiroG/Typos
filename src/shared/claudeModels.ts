/**
 * Modelos do Claude que o autor pode escolher pra fazer o motion dos blocos de instrução.
 * Vale pro Claude Code (vai no --model) e pra API da Anthropic. O Codex e a OpenAI ignoram.
 * Vazio = o padrão da conexão (o do Claude Code, ou o "Modelo" da chave da Anthropic).
 */
export const CLAUDE_MOTION_MODELS: { id: string; label: string; hint: string }[] = [
  { id: 'claude-fable-5-2', label: 'Fable 5.2', hint: 'o mais capaz; mais lento e mais caro' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', hint: 'a versão anterior do Fable' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: 'equilíbrio entre qualidade e custo' },
  { id: 'claude-opus-5', label: 'Opus 5', hint: 'o Opus anterior' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: 'mais rápido e barato' }
]

export const claudeModelLabel = (id?: string) => CLAUDE_MOTION_MODELS.find((m) => m.id === id)?.label ?? id ?? ''

/** o modelo que vale pro bloco: o dele, senão o das Configurações; vazio = padrão da conexão */
export const motionModelFor = (blockModel?: string, settingsModel?: string) => blockModel || settingsModel || undefined
