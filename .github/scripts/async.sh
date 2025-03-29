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

LOCK="$(mktemp -t async_lock)"
PIDS="$(mktemp -t async_pid)"
OUTPUTS="$(mktemp -t async_outputs)"

# Run a command in the background, while keeping track of its process ID and output.
run_async() {
  local output_file
  output_file=$(mktemp -t async_output_log)

  # Run the command in the background and capture output to a file
  "$@" &> "$output_file" &
  local pid=$!

  # keep track of the process IDs and output files
  flock "$LOCK"
  echo "$pid" >> "$PIDS"
  echo "$output_file" >> "$OUTPUTS"
  flock -u "$LOCK"
}

# Await all commands run via run_async.
# Aggregate their outputs into the shared $PIPE in the order they were called in.
# Notes:
# - This must be called from the same shell that run_async was called from
# - Because of that, it intentionally doesn't output anything inline.
#   This is to prevent a pitfall: `myVar="$(await_async_commands)"` runs in a subshell and won't halt execution!
await_async_commands() {
  flock "$LOCK"

  # Wait for all async commands
  while read -r pid; do
    wait "$pid"
  done < "$PIDS"

  # Aggregate their outputs (in the order they were called in) to the shared pipe
  while read -r output_file; do
    cat "$output_file"
    rm -f "$output_file"
  done < "$OUTPUTS"

  # Clear the processes and outputs
  : > "$PIDS"
  : > "$OUTPUTS"

  flock -u "$LOCK"
}
