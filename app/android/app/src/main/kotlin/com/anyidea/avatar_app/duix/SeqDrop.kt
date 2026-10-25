package com.anyidea.avatar_app.duix

/** Remembers one cancelled reply so later work for that seq is ignored. */
class SeqDrop {
    @Volatile
    private var dropped = 0

    fun drop(seq: Int) {
        if (seq != 0) dropped = seq
    }

    fun accept(seq: Int): Boolean = seq != dropped
}
