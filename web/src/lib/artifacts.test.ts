import { describe, expect, it } from 'vitest'
import { artifactIdOf, isPlainClick, localArtifactUrl } from './artifacts'

describe('artifactIdOf', () => {
  it('reads the id from either form of artifact URL', () => {
    expect(artifactIdOf('https://claude.ai/artifact/AbC123_x-y')).toBe('AbC123_x-y')
    expect(artifactIdOf('https://claude.ai/code/artifact/6f1e-22')).toBe('6f1e-22')
    expect(artifactIdOf('https://claude.ai/artifact/AbC123?tab=1')).toBe('AbC123')
  })

  it('is null for anything else', () => {
    expect(artifactIdOf('https://claude.ai/chat/AbC123')).toBeNull()
    expect(artifactIdOf('https://example.com/artifact/AbC123')).toBeNull()
  })
})

describe('localArtifactUrl and isPlainClick', () => {
  it('points every artifact at one host-independent local URL', () => {
    expect(localArtifactUrl('AbC123')).toBe('http://localhost:4000/_env/artifact/AbC123/')
  })

  it('treats only an unmodified left click as plain', () => {
    const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }
    expect(isPlainClick(click)).toBe(true)
    expect([{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }].map((change) => isPlainClick({ ...click, ...change }))).toEqual([false, false, false, false])
  })
})
