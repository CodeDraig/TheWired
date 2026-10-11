import { useState } from "react";
import { X, Folder, FolderPlus, Check, ChevronLeft } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useAppSelector } from "@/store/hooks";
import { selectFolders } from "./musicSelectors";
import { createFolder, toggleFolderMembership } from "./folderActions";
import { FolderNameModal } from "./FolderNameModal";

interface AddToFolderModalProps {
  open: boolean;
  onClose: () => void;
  onBack?: () => void;
  /** A track (`31683:…`) or a project (`33123:…`). */
  itemAddrId: string;
}

/** File a track or project into folders: tap to add, tap again to take it
 *  out. Folders are private and follow you to your other devices. */
export function AddToFolderModal({ open, onClose, onBack, itemAddrId }: AddToFolderModalProps) {
  const folders = useAppSelector(selectFolders);
  const [naming, setNaming] = useState(false);

  return (
    <>
      <Modal open={open && !naming} onClose={onClose}>
        <div className="w-full max-w-sm max-h-[90vh] overflow-y-auto rounded-2xl border border-border card-glass p-6 shadow-xl">
          <div className="mb-1 flex items-center justify-between">
            <div className="flex items-center gap-2">
              {onBack && (
                <button onClick={onBack} className="text-soft hover:text-heading" aria-label="Back">
                  <ChevronLeft size={18} />
                </button>
              )}
              <h2 className="text-lg font-semibold text-heading">Add to folder</h2>
            </div>
            <button onClick={onClose} className="text-soft hover:text-heading" aria-label="Close">
              <X size={18} />
            </button>
          </div>
          <p className="mb-4 text-xs text-soft">Private · on your devices</p>

          <div className="max-h-72 space-y-1 overflow-y-auto">
            <button
              onClick={() => setNaming(true)}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-heading transition-colors hover:bg-surface"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded bg-card">
                <FolderPlus size={14} className="text-muted" />
              </div>
              <span>New folder…</span>
            </button>
            {folders.map((folder) => {
              const inside = folder.itemIds.includes(itemAddrId);
              return (
                <button
                  key={folder.id}
                  onClick={() => toggleFolderMembership(folder.id, itemAddrId)}
                  aria-pressed={inside}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-surface"
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded bg-card">
                    <Folder size={14} className="text-muted" />
                  </div>
                  <div className="min-w-0 flex-1 text-left">
                    <p className="truncate text-sm text-heading">{folder.name}</p>
                    <p className="truncate text-xs text-soft">
                      {folder.itemIds.length} item{folder.itemIds.length !== 1 ? "s" : ""}
                      {folder.publishedAs ? " · published" : ""}
                    </p>
                  </div>
                  {inside && <Check size={16} className="shrink-0 text-green-400" />}
                </button>
              );
            })}
          </div>
        </div>
      </Modal>
      <FolderNameModal
        open={open && naming}
        onClose={() => setNaming(false)}
        onSubmit={(name) => createFolder(name, [itemAddrId])}
      />
    </>
  );
}
