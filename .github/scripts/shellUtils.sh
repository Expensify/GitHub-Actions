#!/bin/bash

# Check if GREEN has already been defined
if [ -z "${GREEN+x}" ]; then
    readonly GREEN=$'\e[1;32m'
fi

# Check if YELLOW has already been defined
if [ -z "${YELLOW+x}" ]; then
    readonly YELLOW=$'\e[1;33m'
fi

# Check if RED has already been defined
if [ -z "${RED+x}" ]; then
    readonly RED=$'\e[1;31m'
fi

# Check if BLUE has already been defined
if [ -z "${BLUE+x}" ]; then
    readonly BLUE=$'\e[1;34m'
fi

# Check if TITLE has already been defined
if [ -z "${TITLE+x}" ]; then
    readonly TITLE=$'\e[1;4;34m'
fi

# Check if RESET has already been defined
if [ -z "${RESET+x}" ]; then
    readonly RESET=$'\e[0m'
fi

function success() {
    echo "🎉 $GREEN$1$RESET"
}

function warning() {
    echo "⚠️ $YELLOW$1$RESET"
}

function error() {
    echo "💥 $RED$1$RESET"
}

function info() {
    echo "$BLUE$1$RESET"
}

function title() {
    printf "\n%s%s%s\n" "$TITLE" "$1" "$RESET"
}
