export function buildKeyboard(context) {
  return { inline_keyboard: [[{ text: 'Fixture', callback_data: `fixture:${context?.chatId ?? ''}` }]] }
}

export async function handleCallback(callbackData, context) {
  if (callbackData === 'fixture:handled') return { handled: true, answerText: 'fixture done' }
  return { handled: false }
}
