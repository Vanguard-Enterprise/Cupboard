export type PelicanServer = {
  uuid: string;
  identifier: string;
  name: string;
  node: string;
  suspended: boolean;
  installing: boolean;
  transferring: boolean;
};
export type PelicanConnection = {
  id: string;
  revision: number;
  panelUrl: string;
  checkedAt: number;
  lastSuccessAt: number | null;
  error: string | null;
  servers: PelicanServer[];
};
export function pelicanStatus(connection: PelicanConnection, now: number) {
  if (connection.error) return "Needs attention";
  if (!connection.lastSuccessAt || now - connection.lastSuccessAt > 360_000)
    return "Check overdue";
  return "Connected";
}
