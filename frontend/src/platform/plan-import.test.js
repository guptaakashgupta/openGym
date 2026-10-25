// The shared plan-import rules as the app runs them (lib/plan-share.js, the app's own catalogue),
// against the same cases the API runs under plain Node (api/test/platform/plan-import.test.js).
import { test } from 'vitest'
import { planImportCases } from '../../../api/test/platform/plan-import-contract.mjs'
import { buildPlanBundle, parsePlan, mergePlan } from '../lib/plan-share.js'

for (const [name, run] of Object.entries(planImportCases({ buildPlanBundle, parsePlan, mergePlan }))) test(name, run)
