package ai.guiji.duix.sdk.client.loader;

import android.content.Context;

/** No-op replacement for the vendor class that posted device data to a remote endpoint. */
final class InfoRequest implements Runnable {
    public final Context a;

    public InfoRequest(Context context) {
        this.a = context;
    }

    @Override
    public void run() {
        // Intentionally empty: the app must not report device information.
    }
}
