import { describe, expect, it } from "vitest";
import {
  MAX_FILES_PER_CHALLENGE,
  MAX_TOTAL_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  checkUploadLimits,
  sanitizeUploadName,
  storedFileName,
} from "@/lib/uploads";

describe("sanitizeUploadName", () => {
  it("keeps a plain name", () => {
    expect(sanitizeUploadName("app.bin")).toBe("app.bin");
  });

  it("drops the directory part (no path traversal)", () => {
    expect(sanitizeUploadName("C:\\Users\\me\\app.bin")).toBe("app.bin");
    expect(sanitizeUploadName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeUploadName("/absolute/path/file.txt")).toBe("file.txt");
  });

  it("replaces unsafe characters (spaces included)", () => {
    expect(sanitizeUploadName("my file?.bin")).toBe("my_file_.bin");
  });

  it("falls back to 'upload' when nothing remains", () => {
    expect(sanitizeUploadName("???")).toBe("upload");
  });
});

describe("storedFileName", () => {
  it("returns the basename of the stored path", () => {
    expect(storedFileName({ path: "uploads/abc/app-2.bin" })).toBe("app-2.bin");
  });
});

describe("checkUploadLimits", () => {
  it("accepts an empty batch", () => {
    expect(
      checkUploadLimits([], MAX_FILES_PER_CHALLENGE, MAX_TOTAL_UPLOAD_BYTES),
    ).toBeNull();
  });

  it("rejects a file over the per-file limit", () => {
    const err = checkUploadLimits([{ size: MAX_UPLOAD_BYTES + 1 }], 0, 0);
    expect(err).toContain("too large");
  });

  it("rejects when the per-challenge count limit is exceeded", () => {
    const err = checkUploadLimits(
      [{ size: 1 }, { size: 1 }],
      MAX_FILES_PER_CHALLENGE,
      0,
    );
    expect(err).toContain("Too many files");
  });

  it("rejects when the total size limit is exceeded", () => {
    const err = checkUploadLimits([{ size: 1 }], 0, MAX_TOTAL_UPLOAD_BYTES);
    expect(err).toContain("100 MB");
  });

  it("accepts a batch within the limits", () => {
    expect(checkUploadLimits([{ size: 10 }, { size: 20 }], 1, 100)).toBeNull();
  });
});
