package com.aihero.avatar.bontime.duix

import ai.guiji.duix.sdk.client.render.DUIXRenderer
import ai.guiji.duix.sdk.client.render.DUIXTextureView
import android.content.Context
import android.opengl.GLSurfaceView
import android.view.View
import io.flutter.plugin.common.StandardMessageCodec
import io.flutter.plugin.platform.PlatformView
import io.flutter.plugin.platform.PlatformViewFactory

class DuixViewFactory(private val frames: ForwardingSink) : PlatformViewFactory(StandardMessageCodec.INSTANCE) {
    override fun create(context: Context, viewId: Int, args: Any?): PlatformView = DuixPlatformView(context, frames)
}

/** Full-screen Duix view; DUIXRenderer crops the frame to cover the view. */
class DuixPlatformView(context: Context, private val frames: ForwardingSink) : PlatformView {
    private val view = DUIXTextureView(context)
    private val renderer = DUIXRenderer(context, view)

    init {
        view.setEGLContextClientVersion(2)
        view.setEGLConfigChooser(8, 8, 8, 8, 16, 0)
        view.isOpaque = true // Lily ships no alpha mask
        view.setRenderer(renderer)
        view.renderMode = GLSurfaceView.RENDERMODE_WHEN_DIRTY // must follow setRenderer
        frames.target = renderer
    }

    override fun getView(): View = view

    override fun dispose() {
        if (frames.target === renderer) frames.target = null
    }
}
