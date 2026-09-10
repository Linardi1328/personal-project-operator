# PPO slow-host test budgets

Owner diagnostics on implementation 64e521cd52a50966eb76f52ae9da6a54af177de4
passed every gate with Node v24.20.0. Serial regression took 382.222 seconds,
critical lifecycle 400.242 seconds, and integrated acceptance 374.118 seconds.
All exceeded their previous 300-second budgets. These direct results support a
timeout diagnosis but do not replace managed exact-SHA evidence.

The three slow PPO gates now allow 600 seconds each. Syntax remains 60 seconds,
parallel regression 180 seconds, and ordinary-project ceilings remain unchanged.
The PPO-only maximum is 600 seconds; stale-test cancellation waits 60 minutes to
stay beyond the maximum allowed suite duration. Stale merge cancellation remains
30 minutes. Capability metadata must match these budgets.

## Existing open attempts

Do not install this policy and blindly retry an open old-policy attempt. Timeout
changes change the policy hash; the existing identity checks must remain strict.
Reconcile old attempts under their original policy before any migration. A closed
old-policy attempt still needs an explicitly reviewed migration/retry path; this
budget change alone does not authorize it. Never rewrite evidence or manufacture
PASS records. Preserve the Stage 2A implementation and run while that migration is
prepared. This change is not an instruction to cancel or recreate the run.
