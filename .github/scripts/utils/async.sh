#!/bin/bash

# This file contains some utility functions for executing multiple background commands
# and waiting for them to finish, while keeping output sequential

if [[ -z "${CI}" && -z "$(command -v flock)" ]]; then
  if [[ "$OSTYPE" != 'darwin'* || -z "$(command -v brew)" ]]; then
    echo 'This script requires flock to be installed. Please install it and try again'
    exit 1
  fi
  brew install flock
fi

# Create a lock file and assign it fd 200
LOCK="$(mktemp -t async_lock.XXXXXXXXX)"
exec 200>"$LOCK"

# Temp files to keep track of processes and outputs
PIDS="$(mktemp -t async_pid.XXXXXXXXX)"
OUTPUTS="$(mktemp -t async_outputs.XXXXXXXXX)"

# Run a command in the background, while keeping track of its process ID and output.
run_async() {
  local output_file
  output_file=$(mktemp -t async_output_log.XXXXXXXXX)

  # Run the command in the background and capture output to a file
  "$@" &> "$output_file" &
  local pid=$!

  # keep track of the process IDs and output files
  flock 200
  echo "$pid" >> "$PIDS"
  echo "$output_file" >> "$OUTPUTS"
  flock -u 200
}

# Await all commands run via run_async.
# Aggregate their outputs into the shared $PIPE in the order they were called in.
# Notes:
# - This must be called from the same shell that run_async was called from
# - Because of that, it intentionally doesn't output anything inline.
#   This is to prevent a pitfall: `myVar="$(await_async_commands)"` runs in a subshell and won't halt execution!
await_async_commands() {
  flock 200

  # Wait for all async commands
  local exit_code=0
  while read -r pid; do
    if ! wait "$pid"; then
      exit_code=1
    fi
  done < "$PIDS"

  # Aggregate their outputs (in the order they were called in) to the shared pipe
  while read -r output_file; do
    cat "$output_file"
    rm -f "$output_file"
  done < "$OUTPUTS"

  # Clear the processes and outputs
  : > "$PIDS"
  : > "$OUTPUTS"

  flock -u 200
  return $exit_code
}

# Cleanup function to remove temp files
cleanup_async() {
  # Acquire lock
  flock 200

  # Remove temp files
  rm -f "$LOCK"
  rm -f "$PIDS"
  rm -f "$OUTPUTS"
  exec 200>&-
}
