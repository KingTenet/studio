import { describe, expect, it } from 'vitest'
import { jobTitle } from './jobs'

describe('jobTitle', () => {
  it('names the action, then its parameters', () => {
    expect(jobTitle('artifact-index', {})).toBe('artifact-index')
    expect(jobTitle('/run', { action: 'claude-start', message: 'hi' })).toBe('run action=claude-start message=hi')
    expect(jobTitle('stop-session', { paneId: 'w1:p1', on: true })).toBe('stop-session paneId=w1:p1 on=true')
  })

  it('shortens session ids and long text, and leaves out empty values and objects', () => {
    expect(jobTitle('resume', { sessionId: '8452a5a8-9c8d-4380-9908-7f1699e26808', then: undefined })).toBe('resume sessionId=8452a5a8')
    expect(jobTitle('resume', { message: 'x'.repeat(80) })).toBe('resume message=' + 'x'.repeat(39) + '…')
    expect(jobTitle('/run', { action: 'artifact-index', targets: [{ kind: 'x' }] })).toBe('run action=artifact-index')
  })
})
