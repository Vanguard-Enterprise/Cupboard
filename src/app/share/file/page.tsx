import { PublicFileDownload } from "@/components/public-file-download";
export const metadata = {
  title: "Shared file | Cupboard",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export default function SharedFilePage() {
  return <PublicFileDownload />;
}
