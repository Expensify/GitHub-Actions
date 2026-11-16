#!/bin/bash

# Shared helpers for the review block the AI PR reviewer keeps at the bottom of a PR description.
# Sourced by prepareReviewContext.sh and postReviewToPrBody.sh so both agree on the markers.
#
# The block looks like this, and everything outside the markers belongs to people:
#   <!-- expensify-ai-reviewer:start -->
#   <details>...<!-- expensify-ai-reviewer:reviewed-sha=<40 hex> -->...</details>
#   <!-- expensify-ai-reviewer:end -->

export REVIEW_BLOCK_START='<!-- expensify-ai-reviewer:start -->'
export REVIEW_BLOCK_END='<!-- expensify-ai-reviewer:end -->'
export REVIEW_SHA_MARKER_PREFIX='<!-- expensify-ai-reviewer:reviewed-sha='

# Perl setup that compiles $block, the pattern for one review block. A start marker pairs with the nearest
# end marker after it that has no other start marker in between, so a stray marker left by a hand edit
# never swallows the text after it.
# shellcheck disable=SC2016 # Perl expands these variables, not the shell.
REVIEW_BLOCK_PERL='my ($s, $e) = map { quotemeta $ENV{$_} } qw(REVIEW_BLOCK_START REVIEW_BLOCK_END); our $block = qr/$s(?:(?!$s).)*?$e/s;'

# Print stdin with the first review block replaced by $1 and any other review blocks removed.
replaceReviewBlocks() {
    REPLACEMENT="$1" perl -0777 -pe "BEGIN { $REVIEW_BLOCK_PERL }"' my $count = 0; s/$block/$count++ ? "" : $ENV{REPLACEMENT}/ge'
}

# Print stdin with every review block removed.
stripReviewBlocks() {
    replaceReviewBlocks ""
}

# Print the last review block in stdin, markers included, or nothing when there is none.
extractLastReviewBlock() {
    perl -0777 -ne "BEGIN { $REVIEW_BLOCK_PERL }"' my @blocks = /($block)/g; print $blocks[-1] if @blocks'
}
