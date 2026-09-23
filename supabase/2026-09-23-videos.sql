-- For a project that ran schema.sql before 2026-09-23. Run once in the SQL
-- editor; it adds the bucket the page streams a trade's clips from. Fresh
-- projects run schema.sql alone and do not need this.
--
-- Then raise the cap: Project Settings → Storage → "Upload file size limit"
-- starts at 50 MB on every plan, and no bucket can accept more than it.

insert into storage.buckets (id, name, public, allowed_mime_types)
  values ('videos', 'videos', false, '{video/mp4}');

create policy read_videos on storage.objects for select to authenticated
  using (bucket_id = 'videos');
