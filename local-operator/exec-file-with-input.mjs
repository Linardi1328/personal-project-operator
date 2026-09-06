import { execFile } from "node:child_process"

// Unlike execFileSync, asynchronous execFile does not support an input option.
export function execFileWithInput(executable, args, { input, ...options }) {
  return new Promise((resolve, reject) => {
    let stdinError
    const child = execFile(executable, args, options, (error, stdout, stderr) => {
      const failure = error || stdinError
      if (failure) {
        failure.stdout = stdout
        failure.stderr = stderr
        reject(failure)
      } else {
        resolve({ stdout, stderr })
      }
    })
    // Keep broken-pipe errors bounded by the subprocess result, including when
    // the executable exits early to report an authentication or usage error.
    child.stdin.on("error", (error) => { stdinError = error })
    child.stdin.end(input)
  })
}
