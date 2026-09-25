// Room codes: 5 chars from an alphabet without I, O, 0 and 1.

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 5
const MAX_ATTEMPTS = 100

export function generateRoomCode(rand: () => number, taken: (c: string) => boolean): string {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let code = ''
    for (let i = 0; i < CODE_LENGTH; i++) {
      const idx = Math.min(ROOM_CODE_ALPHABET.length - 1, Math.floor(rand() * ROOM_CODE_ALPHABET.length))
      code += ROOM_CODE_ALPHABET[idx]
    }
    if (!taken(code)) return code
  }
  throw new Error('[codes] exhausted')
}

export function normalizeRoomCode(s: string): string | null {
  const code = s.trim().toUpperCase()
  if (code.length !== CODE_LENGTH) return null
  for (const ch of code) {
    if (!ROOM_CODE_ALPHABET.includes(ch)) return null
  }
  return code
}
