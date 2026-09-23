-- For a project that ran 2026-09-23-videos.sql before the page could add a
-- clip itself. Run once in the SQL editor; it lets a signed-in user put a
-- file in the bucket, and still not replace or remove one. Fresh projects
-- run schema.sql alone and do not need this.

create policy add_videos on storage.objects for insert to authenticated
  with check (bucket_id = 'videos');
