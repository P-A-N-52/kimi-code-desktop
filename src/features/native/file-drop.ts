import { useEffect, useState, useCallback } from "react";

export interface UseFileDropUploadReturn {
  /** Whether files are currently being dragged over the window */
  isDragging: boolean;
}

/**
 * Hook to enable file drag-and-drop upload via the window's native drag events.
 * Supports multi-file drops and prevents default browser behavior.
 */
export function useFileDropUpload(
  uploadFn: (files: File[]) => Promise<void>,
): UseFileDropUploadReturn {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    async (event: DragEvent) => {
      event.preventDefault();
      setIsDragging(false);

      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) {
        return;
      }

      const fileArray: File[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files.item(i);
        if (file) {
          fileArray.push(file);
        }
      }

      if (fileArray.length > 0) {
        try {
          await uploadFn(fileArray);
        } catch (error) {
          console.error("File drop upload failed:", error);
        }
      }
    },
    [uploadFn],
  );

  useEffect(() => {
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);

    return () => {
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
    };
  }, [handleDragOver, handleDragLeave, handleDrop]);

  return { isDragging };
}
