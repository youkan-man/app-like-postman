"""Read relation requests from their normal collection/draft owners in UI tests."""


def relation_entries(workspace):
    entries = []
    saved_requests = set()

    def append(owner, collection_id=None):
        request = owner.get('request', {})
        if request.get('type') == 'relation':
            relation = {**request['relation'], 'name': owner['name']}
            entries.append({'owner': owner, 'request': request, 'relation': relation,
                            'collectionId': collection_id})

    def walk(items, collection_id):
        for item in items:
            if 'request' in item:
                saved_requests.add((collection_id, item['_mpId']))
            append(item, collection_id)
            walk(item.get('item', []), collection_id)

    for collection in workspace.get('collections', []):
        walk(collection.get('item', []), collection['_mpId'])
    for draft in workspace.get('tabs', []):
        if (draft.get('collectionId'), draft.get('itemId')) not in saved_requests:
            append(draft)
    return entries


def relations(workspace):
    return [entry['relation'] for entry in relation_entries(workspace)]
