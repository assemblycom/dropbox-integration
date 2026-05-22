export enum ObjectType {
  FILE = 'file',
  FOLDER = 'folder',
}
export type ObjectTypeValue = (typeof ObjectType)[keyof typeof ObjectType]

export enum DropboxClientType {
  ROOT = 'root',
  NAMESPACE_ID = 'namespace_id',
}
export type DropboxClientTypeValue = (typeof DropboxClientType)[keyof typeof DropboxClientType]

export enum PendingAction {
  DELETE = 'delete',
  CREATE = 'create',
  UPDATE = 'update',
}
export type PendingActionValue = (typeof PendingAction)[keyof typeof PendingAction]

export enum PendingActionTarget {
  ASSEMBLY = 'assembly',
  DROPBOX = 'dropbox',
}
export type PendingActionTargetValue =
  (typeof PendingActionTarget)[keyof typeof PendingActionTarget]
