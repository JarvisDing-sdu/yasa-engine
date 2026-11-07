struct wc { void (*dtor)(void *); void *data; };
static void wc_data_dtor(void *p) { (void)p; }
void wc_init(struct wc *w) { w->dtor = wc_data_dtor; }
void wc_free(struct wc *w) { if(w->dtor) w->dtor(w->data); }
