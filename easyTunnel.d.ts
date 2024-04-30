import {EventEmitter} from 'events';

declare interface Tunnel extends EventEmitter {
    url: string;
}

declare interface BootstrapOpts {
    port: number;
    host: string;
    subdomain?: string;
    local_host?: string;
    local_https?: boolean;
    local_cert?: string;
    local_key?: string;
    local_ca?: string;
    allow_invalid_cert?: boolean;
    request_secure_tunnel?: boolean;
    local_max_reconnect_count?: number;
}

declare const localtunnel: (opts: BootstrapOpts) => Promise<Tunnel>;

export default localtunnel;