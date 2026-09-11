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

## Existing attempts

Open attempts must first be reconciled under the original policy. The retry
boundary accepts a closed failed aggregate under the exact predecessor policy:
only the three 300-second budgets may differ from the current 600-second policy.
Project, SHA, attempt, commands, executable paths, environment, sandbox, version
and aggregate validation remain mandatory. Old PASS and open evidence cannot
use this compatibility path. No evidence is rewritten or credited as a new PASS.
The existing runner reserves a fresh attempt and enforces its normal version,
workspace, sandbox and attempt-limit checks before execution.

Install the reviewed host repair before retrying a reconciled old-policy run.
The managed implementation workspace remains unchanged. Its later delivery must
still pass existing base-drift reconciliation and exact-SHA tests/review; these
changes do not authorize bypassing those checks or merging stale policy files.
