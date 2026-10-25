// The gym API (api/platform/routes.js), through the app's own api(): the browser's session cookie
// and a paired phone's bearer token are handled there, exactly as for every other request.
import { api } from '../lib/api.js'

const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) })
const del = path => api(path, { method: 'DELETE', body: '{}' })
const id = s => encodeURIComponent(s)

export const platformMe = () => api('/api/platform/me')
export const gymMembers = gymId => api(`/api/platform/gyms/${id(gymId)}/members`)
export const gymInvitations = gymId => api(`/api/platform/gyms/${id(gymId)}/invitations`)
export const createInvitation = (gymId, role) => post(`/api/platform/gyms/${id(gymId)}/invitations`, { role })
export const revokeInvitation = (gymId, invitationId) => del(`/api/platform/gyms/${id(gymId)}/invitations/${id(invitationId)}`)
export const assignTrainer = (gymId, memberMembershipId, trainerMembershipId) => post(`/api/platform/gyms/${id(gymId)}/assignments`, { memberMembershipId, trainerMembershipId })
export const unassign = (gymId, assignmentId) => del(`/api/platform/gyms/${id(gymId)}/assignments/${id(assignmentId)}`)
export const endMembership = (gymId, membershipId) => post(`/api/platform/gyms/${id(gymId)}/memberships/${id(membershipId)}/end`)
export const myClients = () => api('/api/platform/clients')
export const clientWorkouts = membershipId => api(`/api/platform/clients/${id(membershipId)}/workouts`)
export const sendProposal = (membershipId, bundle, previousVersionId) => post(`/api/platform/clients/${id(membershipId)}/proposals`, { bundle, ...(previousVersionId ? { previousVersionId } : {}) })
export const proposals = () => api('/api/platform/proposals')
export const proposal = versionId => api(`/api/platform/proposals/${id(versionId)}`)
export const declineProposal = versionId => post(`/api/platform/proposals/${id(versionId)}/decline`)
export const acceptProposal = (versionId, body) => post(`/api/platform/proposals/${id(versionId)}/accept`, body)
export const previewInvitation = token => post('/api/platform/invitations/preview', { token })
export const redeemInvitation = token => post('/api/platform/invitations/redeem', { token })
