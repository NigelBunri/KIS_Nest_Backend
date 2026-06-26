import { CallsService } from './calls.service'

describe('CallsService user-facing history status', () => {
  const service = new CallsService({} as any)

  const call = (overrides: Record<string, any> = {}) => ({
    status: 'ended',
    createdBy: 'caller',
    participants: [
      {
        userId: 'caller',
        status: 'left',
        joinedAt: null,
      },
      {
        userId: 'recipient',
        status: 'invited',
        joinedAt: null,
      },
    ],
    ...overrides,
  })

  it('shows active calls as ongoing', () => {
    expect(service.getUserFacingStatus(call({ status: 'active' }), 'recipient')).toBe('ongoing')
  })

  it('shows a cancelled-before-answer call as cancelled for the caller', () => {
    expect(service.getUserFacingStatus(call(), 'caller')).toBe('cancelled')
  })

  it('shows an unanswered call as missed for the recipient', () => {
    expect(service.getUserFacingStatus(call(), 'recipient')).toBe('missed')
  })

  it('shows an ended call as completed only after the user actually joined', () => {
    const completed = call({
      participants: [
        { userId: 'caller', status: 'left', joinedAt: new Date() },
        { userId: 'recipient', status: 'left', joinedAt: new Date() },
      ],
    })
    expect(service.getUserFacingStatus(completed, 'caller')).toBe('completed')
    expect(service.getUserFacingStatus(completed, 'recipient')).toBe('completed')
  })

  it('preserves declined and busy outcomes for the recipient', () => {
    const declined = call({
      participants: [{ userId: 'recipient', status: 'rejected', joinedAt: null }],
    })
    const busy = call({
      participants: [{ userId: 'recipient', status: 'busy', joinedAt: null }],
    })
    expect(service.getUserFacingStatus(declined, 'recipient')).toBe('declined')
    expect(service.getUserFacingStatus(busy, 'recipient')).toBe('busy')
  })
})
