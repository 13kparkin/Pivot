import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  PositiveInt,
  PullRequestDiffSide,
  ReviewFindingSeverity,
  ReviewRunVerdict,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";

const ReviewFindingInputSchema = Schema.Struct({
  file: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  line: Schema.NullOr(PositiveInt).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  side: PullRequestDiffSide.pipe(Schema.withDecodingDefault(Effect.succeed("right"))),
  severity: ReviewFindingSeverity.pipe(Schema.withDecodingDefault(Effect.succeed("should-fix"))),
  symbol: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type ReviewFindingInput = typeof ReviewFindingInputSchema.Type;

const ReviewFindingsBlockSchema = Schema.Struct({
  findings: Schema.Array(ReviewFindingInputSchema),
  verdict: Schema.optional(ReviewRunVerdict),
  summary: Schema.optional(TrimmedNonEmptyString),
  filesReviewed: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});

const decodeReviewFindingsBlock = Schema.decodeUnknownOption(ReviewFindingsBlockSchema);

function parseJsonBlock(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The agent's final findings block, decoded from its last fenced JSON. */
export interface DecodedReviewBlock {
  readonly findings: ReadonlyArray<ReviewFindingInput>;
  readonly verdict?: ReviewRunVerdict;
  readonly summary?: string;
  readonly filesReviewed?: ReadonlyArray<string>;
}

/**
 * Decodes the review agent's final fenced JSON findings block from the turn's
 * assistant text: last ` ```json ` fence, JSON parse, schema decode. Null when
 * the text holds no parseable block — the caller fails the turn then.
 */
export class ReviewBlockDecoder {
  decode(runText: string | null): DecodedReviewBlock | null {
    if (runText === null || runText.length === 0) {
      return null;
    }
    // The persona ends with one fenced JSON block; take the last one so any
    // incidental prose fences earlier in the review are ignored.
    const fence = /```json\s*([\s\S]*?)```/gu;
    let last: RegExpExecArray | null = null;
    let match: RegExpExecArray | null;
    while ((match = fence.exec(runText)) !== null) {
      last = match;
    }
    if (last === null) {
      return null;
    }
    const blockText = last[1];
    if (blockText === undefined) {
      return null;
    }
    const parsed = parseJsonBlock(blockText);
    if (parsed === undefined) {
      return null;
    }
    const decoded = decodeReviewFindingsBlock(parsed);
    if (Option.isNone(decoded)) {
      return null;
    }
    const { verdict, summary, filesReviewed } = decoded.value;
    return {
      findings: decoded.value.findings,
      ...(verdict === undefined ? {} : { verdict }),
      ...(summary === undefined ? {} : { summary }),
      ...(filesReviewed === undefined ? {} : { filesReviewed }),
    };
  }
}
