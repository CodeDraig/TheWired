import { useEffect, useState } from "react";
import { Folder } from "lucide-react";
import { cn } from "@/lib/utils";

/** A folder's cover: its first member's artwork, or the folder glyph when
 *  there is none or it fails to load (a dead blob URL must not leave a
 *  broken-image box). */
export function FolderCover({ uri, className, iconSize = 18 }: { uri: string | null; className: string; iconSize?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [uri]);
  if (uri && !failed) {
    return <img src={uri} alt="" className={cn(className, "object-cover")} onError={() => setFailed(true)} />;
  }
  return (
    <div className={cn(className, "flex items-center justify-center bg-card")}>
      <Folder size={iconSize} className="text-muted" />
    </div>
  );
}
