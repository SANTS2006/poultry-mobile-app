-- Chat files may now be up to 50 MB (videos). The size limit is also enforced by the API; this keeps the database rule in step with it.
ALTER TABLE "ChatAttachment" DROP CONSTRAINT "ChatAttachment_size_chk";
ALTER TABLE "ChatAttachment" ADD CONSTRAINT "ChatAttachment_size_chk" CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 52428800);
