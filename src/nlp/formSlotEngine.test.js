import { describe, it, expect } from 'vitest';
import { extractValue } from './formSlotEngine.js';

describe('extractValue', () => {
  it('extracts a number for decimal/integer fields, searching after the matched trigger first', () => {
    const field = { type: 'decimal', choices: [] };
    expect(extractValue('systolic is 148 today', 'systolic', field)).toBe('148');
    // No number after the trigger — falls back to searching the whole text.
    expect(extractValue('148 was the systolic reading', 'systolic', field)).toBe('148');
  });

  it('matches a choice field against its known answerOption values, case-insensitively', () => {
    const field = { type: 'choice', choices: ['arrived', 'in-progress', 'finished'] };
    expect(extractValue('mark the encounter as Finished please', 'status', field)).toBe('finished');
    expect(extractValue('nothing relevant here', 'status', field)).toBeNull();
  });

  it('captures freeform text after the trigger, stripping a leading connector and stopping at punctuation', () => {
    const field = { type: 'string', choices: [] };
    expect(extractValue('chief complaint is persistent cough. patient otherwise well', 'chief complaint', field)).toBe('persistent cough');
    expect(extractValue('subjective: patient reports fatigue', 'subjective', field)).toBe('patient reports fatigue');
  });

  it('returns null when nothing usable follows the trigger', () => {
    const field = { type: 'string', choices: [] };
    expect(extractValue('subjective', 'subjective', field)).toBeNull();
  });
});
