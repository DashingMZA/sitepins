import { PutObjectCommand } from "@aws-sdk/client-s3";
import config from "../../config/variables";
import { ENUM_ROLE } from "../../enums/roles";
import { s3Client } from "../../lib/s3-utils";
import { canUploadToFolder } from "../../lib/uploadFolders";
import { isWorkerRuntime } from "../../lib/workerEnv";
import { sendResponse } from "../../lib/sendResponse";
import { authMiddleware } from "../../middlewares/authMiddleware";
import { uploadLimiter } from "../../middlewares/rateLimiters";
import { resolveEnv } from "../../lib/workerEnv";
import { randomUUID } from "crypto";
import express from "express";
import multer from "multer";
import multerS3 from "multer-s3";

const bucketRouter: express.Router = express.Router();

// multer-s3 hands its callbacks the raw IncomingMessage, not an
// express.Request, and the multipart fields arrive as untyped strings.
type UploadBody = { permission?: string; folder?: string };
const uploadBody = (req: unknown): UploadBody =>
  ((req as { body?: UploadBody }).body ?? {}) as UploadBody;

// Images only — without this, an HTML/JS file served from the bucket origin is
// stored XSS. Mirrors AcceptImages on the client so nothing the UI permits is
// rejected here.
const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
]);

// SVG is a document: opened directly it can run script in the bucket's origin.
// It is still allowed (avatars use it, and <img> never executes SVG script),
// but forced to download on direct navigation, which is what closes the hole.
const INLINE_UNSAFE_MIME = new Set(["image/svg+xml"]);

// Matches the client's MAX_SIZE (10 MB) so the UI can't accept a file the API
// then rejects.
const MAX_UPLOAD_BYTES =
  Number(resolveEnv("MAX_UPLOAD_BYTES")) || 10 * 1024 * 1024;

// Keeps the original name recognizable while making it inert as a key: no
// path separators, no traversal, bounded length.
const safeFileName = (name: string): string => {
  const base = (name.split(/[\\/]/).pop() || "file").replace(/\.{2,}/g, ".");
  return base.replace(/[^A-Za-z0-9._-]/g, "_").slice(-100);
};

// Object key for an upload. Shared by both storage paths so the client
// always gets the same `key` back (the app builds the public URL as
// `${NEXT_PUBLIC_BUCKET_URL}/${key}`).
function buildObjectKey(
  req: express.Request,
  file: Express.Multer.File,
): string {
  const folder = uploadBody(req).folder;
  if (!folder) {
    throw new Error("Folder name is required");
  }
  if (!canUploadToFolder(folder, req.user)) {
    throw new Error("Invalid folder");
  }
  // randomUUID prevents one uploader from clobbering another's object by
  // racing the same millisecond + filename.
  return `${folder}/${Date.now()}-${randomUUID()}-${safeFileName(file.originalname)}`;
}

// Storage selection:
// - Node (local / Docker / VPS): multer-s3 streams straight to the bucket,
//   exactly as before.
// - Cloudflare Worker: multer-s3 cannot run (it needs Node request streams
//   and the S3 client's Node HTTP handler). Instead multer buffers the file
//   in memory (10 MB cap, same as the client limit) and the handler uploads
//   it with the AWS SDK v3 `PutObjectCommand`, which is fetch-based and
//   works on Workers — including against an R2 endpoint. R2 ignores S3
//   ACLs, so `permission` is validated but not applied; the bucket must be
//   public (r2.dev or a custom domain) for NEXT_PUBLIC_BUCKET_URL to serve
//   the object, which is how the app consumes uploads.
//
// Lazy: built on the first upload, NOT at import time. multer-s3 throws
// "bucket is required" when constructed without a bucket, so building it
// at import crashed the whole API on startup whenever S3_BUCKET_NAME was
// missing — even if nobody ever uploaded. Now the API boots fine and only
// /upload reports the missing config, with a message that says where to
// fix it.
let uploadFile: ReturnType<typeof multer> | null = null;

function getUploadFile() {
  if (uploadFile) return uploadFile;
  if (!isWorkerRuntime() && !config.s3_bucket_name) {
    throw new Error(
      "S3_BUCKET_NAME is not set — add it to api/.env (e.g. my-media-bucket) and restart the API.",
    );
  }
  uploadFile = isWorkerRuntime()
    ? multer({
        limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
        fileFilter: (_req, file, cb) => {
          if (!ALLOWED_MIME.has(file.mimetype)) {
            return cb(new Error("Unsupported file type. Images only."));
          }
          cb(null, true);
        },
        storage: multer.memoryStorage(),
      })
    : multer({
        limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
        fileFilter: (req, file, cb) => {
          if (!ALLOWED_MIME.has(file.mimetype)) {
            return cb(new Error("Unsupported file type. Images only."));
          }
          cb(null, true);
        },
        storage: multerS3({
          // multer-s3 pins an older @aws-sdk/client-s3 major than the one we use.
          s3: s3Client as unknown as NonNullable<
            Parameters<typeof multerS3>[0]
          >["s3"],
          bucket: config.s3_bucket_name as string,
          contentType: multerS3.AUTO_CONTENT_TYPE,
          contentDisposition: function (req, file, cb) {
            cb(
              null,
              INLINE_UNSAFE_MIME.has(file.mimetype) ? "attachment" : "inline",
            );
          },
          acl: function (req, file, cb) {
            const permission = uploadBody(req).permission;
            if (permission === "public-read" || permission === "private") {
              cb(null, permission);
            } else {
              cb(new Error("Invalid ACL type specified"));
            }
          },
          key: function (req: express.Request, file, cb) {
            try {
              cb(null, buildObjectKey(req, file));
            } catch (err) {
              cb(err as Error);
            }
          },
        }),
      });
  return uploadFile;
}

// upload router
bucketRouter.post(
  "/upload",
  authMiddleware.verifyAuth(
    ENUM_ROLE.ADMIN,
    ENUM_ROLE.MODERATOR,
    ENUM_ROLE.USER,
  ),
  uploadLimiter,
  (req, res, next) => {
    let uploadSingle: ReturnType<ReturnType<typeof multer>["single"]>;
    try {
      uploadSingle = getUploadFile().single("file");
    } catch (err) {
      return next(err);
    }

    uploadSingle(req, res, (err) => {
      if (err) {
        return next(err);
      }
      // Worker path: the file is in memory — upload it to the bucket now
      // and shape the result like multer-s3's `req.file` ({ key, ... }).
      if (isWorkerRuntime() && req.file?.buffer) {
        const file = req.file;
        const permission = uploadBody(req).permission;
        if (permission !== "public-read" && permission !== "private") {
          return next(new Error("Invalid ACL type specified"));
        }
        let key: string;
        try {
          key = buildObjectKey(req, file);
        } catch (keyErr) {
          return next(keyErr);
        }
        s3Client
          .send(
            new PutObjectCommand({
              Bucket: config.s3_bucket_name as string,
              Key: key,
              Body: file.buffer,
              ContentType: file.mimetype,
              ContentDisposition: INLINE_UNSAFE_MIME.has(file.mimetype)
                ? "attachment"
                : "inline",
            }),
          )
          .then(() => {
            const uploaded = {
              ...file,
              buffer: undefined,
              key,
              bucket: config.s3_bucket_name,
              // The app builds the public URL from the key; there is no
              // canonical public URL known to the API (R2 public URL lives
              // in the app's NEXT_PUBLIC_BUCKET_URL).
              location: key,
            };
            return sendResponse(res, {
              statusCode: 200,
              success: true,
              message: "File uploaded successfully",
              result: uploaded,
            });
          })
          .catch(next);
        return;
      }
      return sendResponse(res, {
        statusCode: 200,
        success: true,
        message: "File uploaded successfully",
        result: req.file,
      });
    });
  },
);

export default bucketRouter;
