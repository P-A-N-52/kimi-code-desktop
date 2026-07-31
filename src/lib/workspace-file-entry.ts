export type WorkspaceFileEntry = {
  name: string;
  type: "directory" | "file";
  size?: number;
};
