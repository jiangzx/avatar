package com.anyidea.avatar_app.duix

import ai.guiji.duix.sdk.client.bean.ImageFrame
import ai.guiji.duix.sdk.client.render.RenderSink

/** Lets the engine outlive any one view: frames go to whichever renderer is attached now. */
class ForwardingSink : RenderSink {
    @Volatile
    var target: RenderSink? = null

    override fun onVideoFrame(imageFrame: ImageFrame) {
        target?.onVideoFrame(imageFrame)
    }
}
