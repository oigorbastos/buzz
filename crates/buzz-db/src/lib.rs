#![deny(unsafe_code)]
#![warn(missing_docs)]
//! buzz-db — Postgres event store for Buzz.
//!
//! Runtime infrastructure and domain persistence live in separate internal
//! modules while this facade preserves the crate-root API used by callers.

mod runtime;
mod store;

pub(crate) use buzz_core::CommunityId;

/// Database error types.
pub mod error;

pub use runtime::{
    insert_mentions, migration, replica_fence, Db, DbConfig, DbPoolStats, ReadSession,
};
pub use store::{
    admin_moderation, allowlist, api_token, archived_identities, channel, channel_members,
    community, deletion, dm, event, feed, git_repo, lab, moderation, partition, product_feedback,
    push, reaction, relay_invite, relay_members, reminder, replaceable, thread, usage, user,
    workflow,
};

pub use error::{DbError, Result};
pub use store::allowlist::AllowlistEntry;
pub use store::api_token::{ApiTokenRecord, TokenSummary};
pub use store::community::{
    ArchivedCommunityRecord, CommunityRecord, CreateCommunityWithOwnerResult,
    CreatedCommunityRecord, EnsuredCommunityRecord, OwnedCommunityRecord,
    UnarchivedCommunityRecord,
};
pub use store::event::{EventQuery, ReactionEventInsertOutcome, DEFAULT_MAX_PAGE_LIMIT};
pub use store::reminder::DueReminder;
pub use store::usage::UsageMetricsLeader;
