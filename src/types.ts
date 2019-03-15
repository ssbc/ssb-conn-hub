export type Address = string;

export type ConnectionData = Readonly<{
  state: 'connecting' | 'connected' | 'disconnecting';
  disconnect?: (cb: (err?: any) => void) => void;
  key?: string;
}>;

export type ListenEvent = Readonly<{
  type:
    | ConnectionData['state']
    | 'connecting-failed'
    | 'disconnecting-failed'
    | 'disconnected';
  address: Address;
  key?: string;
  details?: any;
}>;
