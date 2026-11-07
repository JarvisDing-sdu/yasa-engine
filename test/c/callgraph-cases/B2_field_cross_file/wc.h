struct wc { void (*dtor)(void *); void *data; };
void wc_init(struct wc *w);
void wc_free(struct wc *w);
