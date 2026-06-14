/**
 * Spoken-number parsing for verse references: "sixteen" → 16,
 * "twenty one" → 21, "one hundred and twenty one" → 121, "3" → 3.
 */

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
}

const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
}

const ORDINAL_UNITS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
  fortieth: 40, fiftieth: 50, sixtieth: 60, seventieth: 70, eightieth: 80,
  ninetieth: 90, hundredth: 100,
}

export function isNumberWord(token: string): boolean {
  return (
    token in UNITS || token in TENS || token === 'hundred' || token === 'and' || /^\d+$/.test(token)
  )
}

export function isOrdinalWord(token: string): boolean {
  return token in ORDINAL_UNITS || /^\d+(st|nd|rd|th)$/.test(token)
}

export function ordinalValue(token: string): number | null {
  if (token in ORDINAL_UNITS) return ORDINAL_UNITS[token]
  const m = token.match(/^(\d+)(st|nd|rd|th)$/)
  return m ? parseInt(m[1], 10) : null
}

/**
 * Consume a number starting at `start` in `tokens`.
 * Returns the value and how many tokens were consumed, or null.
 * Handles digits ("121"), unit words, tens+unit ("twenty one"),
 * hundreds ("one hundred and twenty one", "hundred twenty").
 */
export function parseNumber(tokens: string[], start: number): { value: number; consumed: number } | null {
  let i = start
  if (i >= tokens.length) return null

  // Plain digits — the common whisper output
  if (/^\d+$/.test(tokens[i])) {
    return { value: parseInt(tokens[i], 10), consumed: 1 }
  }

  let value = 0
  let current = 0
  let consumed = 0
  let matchedAny = false

  while (i < tokens.length) {
    const tok = tokens[i]
    if (tok in UNITS) {
      if (matchedAny) break // "three sixteen" = two separate numbers
      current += UNITS[tok]
      matchedAny = true
      i++
      consumed++
      // a unit ends a group unless followed by "hundred"
      if (tokens[i] !== 'hundred') break
    } else if (tok in TENS) {
      if (current % 100 >= 20) break
      current += TENS[tok]
      matchedAny = true
      i++
      consumed++
      // optionally a unit follows: "twenty one"
      if (i < tokens.length && tokens[i] in UNITS && UNITS[tokens[i]] < 10) {
        current += UNITS[tokens[i]]
        i++
        consumed++
      }
      break
    } else if (tok === 'hundred') {
      current = (current === 0 ? 1 : current) * 100
      matchedAny = true
      i++
      consumed++
      if (tokens[i] === 'and') {
        i++
        consumed++
      }
    } else {
      break
    }
  }

  value += current
  if (!matchedAny) return null
  return { value, consumed }
}
