//! Community allowlist persistence.

use crate::{Db, Result};
use buzz_core::CommunityId;
use buzz_datastore_tracing::datastore_span;
use chrono::{DateTime, Utc};
use sqlx::Row;

/// An entry in the pubkey allowlist.
#[derive(Debug, Clone)]
pub struct AllowlistEntry {
    /// The allowed pubkey.
    pub pubkey: Vec<u8>,
    /// Who added this entry.
    pub added_by: Vec<u8>,
    /// When the entry was added.
    pub added_at: DateTime<Utc>,
    /// Optional note.
    pub note: Option<String>,
}

impl Db {
    /// Check if a pubkey is in the allowlist for `community`.
    #[datastore_span(name = "is_pubkey_allowed", system = "postgresql")]
    pub async fn is_pubkey_allowed(&self, community: CommunityId, pubkey: &[u8]) -> Result<bool> {
        let row = sqlx::query(
            "SELECT COUNT(*) as cnt FROM pubkey_allowlist WHERE community_id = $1 AND pubkey = $2",
        )
        .bind(community.as_uuid())
        .bind(pubkey)
        .fetch_one(&self.pool)
        .await?;
        let cnt: i64 = row.try_get("cnt")?;
        Ok(cnt > 0)
    }

    /// Check if the community allowlist has any entries (i.e. is enforcement active).
    #[datastore_span(name = "has_allowlist_entries", system = "postgresql")]
    pub async fn has_allowlist_entries(&self, community: CommunityId) -> Result<bool> {
        let row =
            sqlx::query("SELECT COUNT(*) as cnt FROM pubkey_allowlist WHERE community_id = $1")
                .bind(community.as_uuid())
                .fetch_one(&self.pool)
                .await?;
        let cnt: i64 = row.try_get("cnt")?;
        Ok(cnt > 0)
    }

    /// Add a pubkey to the community allowlist.
    #[datastore_span(name = "add_to_allowlist", system = "postgresql")]
    pub async fn add_to_allowlist(
        &self,
        community: CommunityId,
        pubkey: &[u8],
        added_by: &[u8],
        note: Option<&str>,
    ) -> Result<bool> {
        let result = sqlx::query(
            "INSERT INTO pubkey_allowlist (community_id, pubkey, added_by, note) VALUES ($1, $2, $3, $4) \
             ON CONFLICT DO NOTHING",
        )
        .bind(community.as_uuid())
        .bind(pubkey)
        .bind(added_by)
        .bind(note)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Remove a pubkey from the community allowlist.
    #[datastore_span(name = "remove_from_allowlist", system = "postgresql")]
    pub async fn remove_from_allowlist(
        &self,
        community: CommunityId,
        pubkey: &[u8],
    ) -> Result<bool> {
        let result =
            sqlx::query("DELETE FROM pubkey_allowlist WHERE community_id = $1 AND pubkey = $2")
                .bind(community.as_uuid())
                .bind(pubkey)
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() > 0)
    }

    /// List all pubkeys in the community allowlist.
    #[datastore_span(name = "list_allowlist", system = "postgresql")]
    pub async fn list_allowlist(&self, community: CommunityId) -> Result<Vec<AllowlistEntry>> {
        let rows = sqlx::query(
            "SELECT pubkey, added_by, added_at, note FROM pubkey_allowlist WHERE community_id = $1 ORDER BY added_at DESC",
        )
        .bind(community.as_uuid())
        .fetch_all(&self.pool)
        .await?;

        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            out.push(AllowlistEntry {
                pubkey: row.try_get("pubkey")?,
                added_by: row.try_get("added_by")?,
                added_at: row.try_get("added_at")?,
                note: row.try_get("note")?,
            });
        }
        Ok(out)
    }
}
